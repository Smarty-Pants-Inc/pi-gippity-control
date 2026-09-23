import { describe, expect, test } from "bun:test";
import {
	RealtimeDelegationHandoff,
	type RealtimeHandoffChannel,
	type RealtimeHandoffTarget,
} from "../src/voice/conversation/handoff.ts";
import { RealtimeVoiceTurnTracker } from "../src/voice/turns.ts";

// Acceptance probes for ACCEPTANCE-voice-context.md, driven by fakes only.

describe("request spoken across a pause", () => {
	test("the delegation carries the words before the pause", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("make sure the entire fleet");
		turns.userFinished("make sure the entire fleet");
		turns.outputAdded("Go on.");
		turns.assistantFinished("Go on.");
		turns.inputAdded("uses our new GitHub and Fabric workflows");
		const delegated = turns.delegated(
			"Check that the fleet uses the new GitHub and Fabric workflows",
			"d1",
		);
		expect(delegated?.turn.transcriptDelta).toContain(
			"user: make sure the entire fleet",
		);
		expect(delegated?.turn.transcriptDelta).toContain("assistant: Go on.");
	});

	test("a second delegation carries only the new transcript", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("first question");
		turns.delegated("first question", "d1");
		turns.userFinished("first question");
		turns.inputAdded("and also this");
		turns.userFinished("and also this");
		turns.inputAdded("second question");
		const second = turns.delegated("second question", "d2");
		expect(second?.turn.transcriptDelta).toBe("user: and also this");
	});
});

describe("delegation transcript dedupe", () => {
	test("drops a final user turn that only repeats the input", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("Hi.");
		turns.userFinished("Hi.");
		turns.assistantFinished("Hello.");
		turns.inputAdded("  Run the\n tests  on dev2. ");
		turns.userFinished("  Run the\n tests  on dev2. ");
		const delegated = turns.delegated("Run the tests on dev2.", "d1");
		expect(delegated?.turn.transcriptDelta).toBe(
			"user: Hi.\nassistant: Hello.",
		);
	});

	test("keeps a final user turn that adds to the input", () => {
		const turns = new RealtimeVoiceTurnTracker();
		turns.inputAdded("Run the tests on dev2 and then deploy");
		turns.userFinished("Run the tests on dev2 and then deploy");
		const delegated = turns.delegated("Run the tests on dev2.", "d1");
		expect(delegated?.turn.transcriptDelta).toBe(
			"user: Run the tests on dev2 and then deploy",
		);
	});
});

describe("questions asked while Pi is busy", () => {
	test("every answer reaches voice in order", () => {
		const sent = recordHandoff();
		const { handoff } = sent;
		handoff.activate("d1");
		handoff.stream("Working on the first one");
		handoff.progress("Working on the first one");
		handoff.activate("d2");
		handoff.activate("d3");
		for (const answer of [
			"Answer one. It is done.",
			"Answer two. It is done.",
			"Answer three. It is done.",
		]) {
			handoff.stream(answer);
			handoff.result(answer);
		}
		handoff.settle();
		const spoken = sent.calls
			.filter(({ channel }) => channel === "speakable")
			.map(({ content }) => content)
			.join("\n");
		const positions = ["Answer one", "Answer two", "Answer three"].map(
			(answer) => spoken.indexOf(answer),
		);
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	test("an answer is sent at message end, before the run settles", () => {
		const sent = recordHandoff();
		sent.handoff.activate("d1");
		sent.handoff.stream("It is green.");
		sent.handoff.result("It is green.");
		expect(sent.calls).toContainEqual({
			target: { type: "delegation", id: "d1" },
			channel: "speakable",
			content: "It is green.",
		});
		expect(sent.settled).toEqual([]);
	});
});

describe("typing while voice is live", () => {
	test("typed text reaches voice and the reply is spoken", () => {
		const sent = recordHandoff();
		expect(sent.handoff.piInput("What is the CI state?")).toBe(true);
		sent.handoff.stream("CI is green.");
		sent.handoff.result("CI is green.");
		expect(sent.calls[0]).toMatchObject({
			target: { type: "session" },
			channel: "commentary",
		});
		expect(sent.calls[0]?.content).toContain("What is the CI state?");
		expect(sent.calls.at(-1)).toMatchObject({
			channel: "speakable",
			content: "CI is green.",
		});
	});
});

function recordHandoff() {
	const calls: Array<{
		target: RealtimeHandoffTarget;
		channel: RealtimeHandoffChannel;
		content: string;
	}> = [];
	const settled: string[] = [];
	const handoff = new RealtimeDelegationHandoff({
		isActive: () => true,
		onContext: (target, channel, content) =>
			calls.push({ target, channel, content }),
		onSettled: (id) => settled.push(id),
	});
	return { handoff, calls, settled };
}
