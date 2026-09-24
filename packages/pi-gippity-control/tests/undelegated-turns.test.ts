import { afterEach, describe, expect, test } from "bun:test";
import { RealtimeDelegationHandoff } from "../src/voice/conversation/handoff.ts";
import { CodexVoiceSessionMessages } from "../src/voice/session-messages.ts";
import {
	RealtimeVoiceTurnTracker,
	UNDELEGATED_TIMING,
} from "../src/voice/turns.ts";

// Safety net: a final user turn the voice model answered itself, without
// delegating, still reaches Pi exactly once.

const timing = { ...UNDELEGATED_TIMING };
afterEach(() => Object.assign(UNDELEGATED_TIMING, timing));

describe("undelegated voice turns", () => {
	test("an answered but undelegated turn is due 3 s after the reply, once", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("Please change the Pi UX colors");
		turns.userFinished("Please change the Pi UX colors", 0);
		turns.assistantFinished("Got it.", 1_000);
		expect(turns.takeUndelegated(3_999)).toEqual([]);
		expect(turns.takeUndelegated(4_001)).toEqual([
			"Please change the Pi UX colors",
		]);
		expect(turns.takeUndelegated(60_000)).toEqual([]);
	});

	test("a delegated turn is never forwarded", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("Run the tests on dev2");
		turns.userFinished("Run the tests on dev2", 0);
		turns.delegated("Run the tests on dev2.", "d1");
		turns.assistantFinished("On it.", 1_000);
		expect(turns.takeUndelegated(20_000)).toEqual([]);
	});

	test("a turn a later delegation carried in its transcript is not forwarded", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("make sure the fleet");
		turns.userFinished("make sure the fleet", 0);
		turns.assistantFinished("Go on.", 500);
		turns.inputAdded("uses the new workflows");
		const delegated = turns.delegated("Check the fleet workflows", "d1");
		expect(delegated?.turn.transcriptDelta).toContain("make sure the fleet");
		expect(turns.takeUndelegated(20_000)).toEqual([]);
	});

	test("a forwarded turn is not repeated in a later delegation or tail", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("the colors thing");
		turns.userFinished("the colors thing", 0);
		turns.assistantFinished("Noted.", 500);
		expect(turns.takeUndelegated(4_000)).toEqual(["the colors thing"]);
		turns.inputAdded("now run the tests");
		turns.userFinished("now run the tests", 5_000);
		const delegated = turns.delegated("Run the tests", "d1");
		expect(delegated?.turn.transcriptDelta ?? "").not.toContain("colors");
		expect(turns.takeTranscriptTail() ?? "").not.toContain("colors");
	});

	test("the backstop forwards a turn even if no reply completes", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("are you there");
		turns.userFinished("are you there", 0);
		expect(turns.takeUndelegated(9_999)).toEqual([]);
		expect(turns.takeUndelegated(10_001)).toEqual(["are you there"]);
	});
});

describe("delivery to Pi", () => {
	test("starts a turn when Pi is idle and steers a running turn", () => {
		const sent: Array<{ message: Record<string, unknown>; options: unknown }> =
			[];
		let idle = true;
		const messages = new CodexVoiceSessionMessages(
			{
				sendMessage: (message: Record<string, unknown>, options: unknown) =>
					sent.push({ message, options }),
				appendEntry() {},
			} as never,
			{ canDelegate: () => true, onDelegation() {}, onWorking() {} },
		);
		messages.setContext({ isIdle: () => idle } as never);
		messages.undelegatedTurn("Can you color the status by side?");
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(String(sent[0]?.message["content"])).toContain(
			"Can you color the status by side?",
		);
		expect(String(sent[0]?.message["content"])).toContain(
			"otherwise reply exactly NOOP",
		);
		idle = false;
		messages.undelegatedTurn("and track this bug");
		expect(sent[1]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	});
});

describe("Pi's reply to an undelegated turn", () => {
	function handoff() {
		const spoken: string[] = [];
		const value = new RealtimeDelegationHandoff({
			isActive: () => true,
			onContext: (_target, channel, content) => {
				if (channel === "speakable") spoken.push(content);
			},
			onSettled() {},
		});
		value.beginStandalone();
		return { value, spoken };
	}

	test("NOOP (chit-chat) is never spoken", () => {
		const { value, spoken } = handoff();
		value.stream("NOOP");
		value.result("NOOP");
		value.settle();
		expect(spoken).toEqual([]);
	});

	test("a request's result is spoken", () => {
		const { value, spoken } = handoff();
		const reply = "Done. The status now uses two colors.";
		value.stream(reply);
		value.result(reply);
		expect(spoken.join(" ")).toContain("two colors");
	});
});
