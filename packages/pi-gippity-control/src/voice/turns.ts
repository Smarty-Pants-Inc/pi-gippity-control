export interface RealtimeVoiceTurn {
	input: string;
	transcriptDelta?: string;
	delegationId?: string;
}

export interface TrackedRealtimeDelegation {
	turn: RealtimeVoiceTurn;
	displayInput: boolean;
}

const MAX_TRANSCRIPT_DELTA_BYTES = 32 * 1024;

interface TranscriptEntry {
	role: "user" | "assistant";
	text: string;
	final: boolean;
	/** Reached Pi inside a delegation (input or transcript delta). */
	claimed?: boolean;
	/** Sent to Pi on its own as an undelegated voice turn. */
	forwarded?: boolean;
	finishedAt?: number;
}

/** When an unclaimed user turn is sent to Pi on its own. */
export const UNDELEGATED_TIMING = {
	/** After the voice's response to it completed. */
	afterResponseMs: 3_000,
	/** Even if no response completed. */
	backstopMs: 10_000,
};

interface PendingDelegation {
	input: string;
	delegationId: string;
}

interface PendingUserInput {
	input: string;
	transcript: TranscriptEntry;
}

class RealtimeTranscriptBuffer {
	private entries: TranscriptEntry[] = [];
	private readonly active = new Map<TranscriptEntry["role"], TranscriptEntry>();

	append(
		role: TranscriptEntry["role"],
		transcript: string,
		startsTurn = false,
	): void {
		const text = transcript.trim();
		if (!text) return;
		const current = this.active.get(role);
		if (current && !startsTurn) current.text += text;
		else {
			const entry = { role, text, final: false };
			this.entries.push(entry);
			this.active.set(role, entry);
		}
		this.bound();
	}

	finish(
		role: TranscriptEntry["role"],
		transcript: string,
		now = Date.now(),
	): TranscriptEntry {
		const text = transcript.trim();
		const current = this.entries.find(
			(entry) => entry.role === role && !entry.final,
		);
		if (current) {
			current.text = text;
			current.final = true;
			current.finishedAt = now;
			if (this.active.get(role) === current) this.active.delete(role);
		} else {
			const entry: TranscriptEntry = {
				role,
				text,
				final: true,
				finishedAt: now,
			};
			this.entries.push(entry);
			this.bound();
			return entry;
		}
		this.bound();
		return current;
	}

	take(): string | undefined {
		if (this.entries.length === 0) return undefined;
		const transcript = this.render();
		claim(this.entries);
		this.reset();
		return transcript;
	}

	/**
	 * Takes finalized entries up to and including the delegated user turn. That
	 * turn is dropped only when the delegation input already contains it, so
	 * words the model left out of the input still reach Pi.
	 */
	takeThrough(currentUser: TranscriptEntry, input: string): string | undefined {
		const currentUserIndex = this.entries.indexOf(currentUser);
		const history =
			currentUserIndex < 0
				? []
				: this.entries
						.slice(0, currentUserIndex + 1)
						.filter(({ final }) => final);
		currentUser.claimed = true;
		if (
			history.at(-1) === currentUser &&
			normalizeWhitespace(input).includes(normalizeWhitespace(currentUser.text))
		)
			history.pop();
		const transcript = this.render(history);
		claim(history);
		this.reset();
		return transcript || undefined;
	}

	takeFinalized(): string | undefined {
		const finalized = this.entries.filter(({ final }) => final);
		const transcript = this.render(finalized);
		claim(finalized);
		this.reset();
		return transcript || undefined;
	}

	reset(): void {
		this.entries = [];
		this.active.clear();
	}

	private bound(): void {
		this.entries = this.entries.filter(
			(entry) =>
				Buffer.byteLength(`${entry.role}: ${entry.text}`) <=
				MAX_TRANSCRIPT_DELTA_BYTES,
		);
		while (Buffer.byteLength(this.render()) > MAX_TRANSCRIPT_DELTA_BYTES)
			this.entries.shift();
		for (const [role, entry] of this.active)
			if (!this.entries.includes(entry)) this.active.delete(role);
	}

	/** Entries already sent to Pi on their own are not repeated. */
	private render(entries = this.entries): string {
		return entries
			.filter((entry) => !entry.forwarded)
			.map(({ role, text }) => `${role}: ${text}`)
			.join("\n");
	}
}

function claim(entries: TranscriptEntry[]): void {
	for (const entry of entries) entry.claimed = true;
}

/** Keeps conversational display turns separate from V3 delegation handoffs. */
export class RealtimeVoiceTurnTracker {
	private readonly transcript = new RealtimeTranscriptBuffer();
	/** Final user turns not yet claimed by a delegation nor forwarded. */
	private userEntries: TranscriptEntry[] = [];
	private lastAssistantDoneAt: number | undefined;
	private pendingUserInputs: PendingUserInput[] = [];
	private recentlyAnsweredUserInput: PendingUserInput | undefined;
	private unfinishedUserTurns: object[] = [];
	private activeUserTurn: object | undefined;
	private delegatedUserFinishes = 0;
	private readonly delegationIds = new Set<string>();
	private readonly outstandingDelegations = new Map<string, string>();
	private readonly outstandingInputs = new Set<string>();

	inputAdded(input: string): void {
		const startsTurn = !this.activeUserTurn;
		if (!this.activeUserTurn) {
			this.recentlyAnsweredUserInput = undefined;
			this.activeUserTurn = {};
			this.unfinishedUserTurns.push(this.activeUserTurn);
		}
		this.transcript.append("user", input, startsTurn);
	}

	outputAdded(output: string): void {
		this.transcript.append("assistant", output);
	}

	userFinished(input: string, now = Date.now()): boolean {
		if (this.delegatedUserFinishes > 0) {
			this.delegatedUserFinishes -= 1;
			return false;
		}
		const turn = this.unfinishedUserTurns.shift();
		if (this.activeUserTurn === turn) this.activeUserTurn = undefined;
		const transcript = this.transcript.finish("user", input, now);
		this.pendingUserInputs.push({ input, transcript });
		this.userEntries.push(transcript);
		return true;
	}

	delegated(
		input: string,
		delegationId: string,
	): TrackedRealtimeDelegation | undefined {
		if (this.delegationIds.has(delegationId)) return undefined;
		this.delegationIds.add(delegationId);
		if (this.outstandingInputs.has(input)) return undefined;
		this.outstandingDelegations.set(delegationId, input);
		this.outstandingInputs.add(input);

		if (this.activeUserTurn) {
			const active = this.activeUserTurn;
			this.activeUserTurn = undefined;
			this.unfinishedUserTurns = this.unfinishedUserTurns.filter(
				(turn) => turn !== active,
			);
			this.delegatedUserFinishes += 1;
			return {
				turn: this.finishDelegation({ input, delegationId }),
				displayInput: true,
			};
		}
		const pendingIndex = this.pendingUserInputs.length - 1;
		if (pendingIndex === -1) {
			if (this.recentlyAnsweredUserInput) {
				const answered = this.recentlyAnsweredUserInput;
				this.recentlyAnsweredUserInput = undefined;
				return {
					turn: this.finishDelegation(
						{ input, delegationId },
						answered.transcript,
					),
					displayInput: false,
				};
			}
			this.delegatedUserFinishes += 1;
			return {
				turn: this.finishDelegation({ input, delegationId }),
				displayInput: true,
			};
		}
		const [pending] = this.pendingUserInputs.splice(pendingIndex, 1);
		this.recentlyAnsweredUserInput = undefined;
		return {
			turn: this.finishDelegation({ input, delegationId }, pending!.transcript),
			displayInput: false,
		};
	}

	delegationSettled(delegationId: string): void {
		const input = this.outstandingDelegations.get(delegationId);
		if (input === undefined) return;
		this.outstandingDelegations.delete(delegationId);
		this.outstandingInputs.delete(input);
	}

	assistantFinished(
		output?: string,
		now = Date.now(),
	): RealtimeVoiceTurn | undefined {
		this.lastAssistantDoneAt = now;
		if (output) this.transcript.finish("assistant", output);
		const answered = this.pendingUserInputs.shift();
		if (answered) this.recentlyAnsweredUserInput = answered;
		return output ? { input: output } : undefined;
	}

	/**
	 * Final user turns that no delegation carried to Pi: due a few seconds
	 * after the voice's response completed, or after a backstop. Each is
	 * returned once and never repeated in a later delta or tail.
	 */
	takeUndelegated(now = Date.now()): string[] {
		const due = this.userEntries.filter(
			(entry) =>
				!entry.claimed &&
				!entry.forwarded &&
				entry.text &&
				entry.finishedAt !== undefined &&
				((this.lastAssistantDoneAt !== undefined &&
					this.lastAssistantDoneAt >= entry.finishedAt &&
					now - this.lastAssistantDoneAt >=
						UNDELEGATED_TIMING.afterResponseMs) ||
					now - entry.finishedAt >= UNDELEGATED_TIMING.backstopMs),
		);
		for (const entry of due) entry.forwarded = true;
		this.userEntries = this.userEntries.filter(
			(entry) => !entry.claimed && !entry.forwarded,
		);
		return due.map((entry) => entry.text);
	}

	takeTranscriptTail(): string | undefined {
		return this.transcript.take();
	}

	drainConversationTurns(): RealtimeVoiceTurn[] {
		this.pendingUserInputs = [];
		this.recentlyAnsweredUserInput = undefined;
		this.unfinishedUserTurns = [];
		this.activeUserTurn = undefined;
		this.delegatedUserFinishes = 0;
		return [];
	}

	reset(): void {
		this.transcript.reset();
		this.userEntries = [];
		this.lastAssistantDoneAt = undefined;
		this.pendingUserInputs = [];
		this.recentlyAnsweredUserInput = undefined;
		this.unfinishedUserTurns = [];
		this.activeUserTurn = undefined;
		this.delegatedUserFinishes = 0;
		this.delegationIds.clear();
		this.outstandingDelegations.clear();
		this.outstandingInputs.clear();
	}

	private finishDelegation(
		delegation: PendingDelegation,
		currentUser?: TranscriptEntry,
	): RealtimeVoiceTurn {
		const transcriptDelta = currentUser
			? this.transcript.takeThrough(currentUser, delegation.input)
			: this.transcript.takeFinalized();
		return {
			input: delegation.input,
			...(transcriptDelta ? { transcriptDelta } : {}),
			delegationId: delegation.delegationId,
		};
	}
}

function normalizeWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}
