import { describe, expect, test } from "bun:test";
import {
	RealtimeDelegationHandoff,
	type RealtimeHandoffChannel,
	type RealtimeHandoffTarget,
} from "../src/voice/conversation/handoff.ts";

// A Pi turn that voice did not request, such as a Fabric or supervisor steer,
// still reaches the live call (Codex's standalone handoff).
describe("Pi turns without a voice handoff", () => {
	test("a steer-triggered reply is spoken without a delegation", () => {
		const sent = recordHandoff();
		sent.handoff.beginStandalone();
		sent.handoff.progress("Checking the build.");
		sent.handoff.stream("The build is green. Deploy is next.");
		sent.handoff.result("The build is green. Deploy is next.");
		sent.handoff.settle();
		expect(sent.calls).toEqual([
			{
				target: { type: "session" },
				channel: "speakable",
				content: "Checking the build.",
			},
			{
				target: { type: "session" },
				channel: "speakable",
				content: "The build is green. Deploy is next.",
			},
		]);
	});

	test("does not take over an active voice delegation", () => {
		const sent = recordHandoff();
		sent.handoff.activate("d1");
		sent.handoff.beginStandalone();
		sent.handoff.result("Done.");
		expect(sent.calls).toEqual([
			{
				target: { type: "delegation", id: "d1" },
				channel: "speakable",
				content: "Done.",
			},
		]);
	});

	test("a voice delegation during a standalone turn takes over", () => {
		const sent = recordHandoff();
		sent.handoff.beginStandalone();
		sent.handoff.activate("d1");
		sent.handoff.result("Answer for d1.");
		expect(sent.calls.at(-1)).toEqual({
			target: { type: "delegation", id: "d1" },
			channel: "speakable",
			content: "Answer for d1.",
		});
	});

	test("does nothing when no call is live", () => {
		const sent = recordHandoff(false);
		sent.handoff.beginStandalone();
		sent.handoff.result("Nobody is listening.");
		expect(sent.calls).toEqual([]);
	});
});

function recordHandoff(active = true) {
	const calls: Array<{
		target: RealtimeHandoffTarget;
		channel: RealtimeHandoffChannel;
		content: string;
	}> = [];
	const handoff = new RealtimeDelegationHandoff({
		isActive: () => active,
		onContext: (target, channel, content) =>
			calls.push({ target, channel, content }),
		onSettled: () => {},
	});
	return { handoff, calls };
}
