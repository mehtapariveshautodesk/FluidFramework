/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { takeAsync } from "@fluid-private/stochastic-test-utils";
import {
	DDSFuzzModel,
	createDDSFuzzSuite,
	DDSFuzzTestState,
	DDSFuzzSuiteOptions,
} from "@fluid-private/test-dds-utils";
import { FlushMode } from "@fluidframework/runtime-definitions";
import { SharedTreeTestFactory, validateTreeConsistency } from "../../utils.js";
import { makeOpGenerator, EditGeneratorOpWeights } from "./fuzzEditGenerators.js";
import { fuzzReducer } from "./fuzzEditReducers.js";
import { deterministicIdCompressorFactory, failureDirectory, onCreate } from "./fuzzUtils.js";
import { Operation } from "./operationTypes.js";

const baseOptions: Partial<DDSFuzzSuiteOptions> = {
	numberOfClients: 3,
	clientJoinOptions: {
		maxNumberOfClients: 6,
		clientAddProbability: 0.1,
	},
	reconnectProbability: 0.5,
};

/**
 * Fuzz tests in this suite are meant to exercise as much of the SharedTree code as possible and do so in the most
 * production-like manner possible. For example, these fuzz tests should not utilize branching APIs to emulate
 * multiple clients working on the same document. Instead, they should use multiple SharedTree instances, tied together
 * by a sequencing service. The tests may still use branching APIs because that's part of the normal usage of
 * SharedTree, but not as way to avoid using multiple SharedTree instances.
 *
 * The fuzz tests should validate that the clients do not crash and that their document states do not diverge.
 * See the "Fuzz - Targeted" test suite for tests that validate more specific code paths or invariants.
 */
describe("Fuzz - Top-Level", () => {
	const runsPerBatch = 50;
	const opsPerRun = 20;
	// TODO: Enable other types of ops.
	const editGeneratorOpWeights: Partial<EditGeneratorOpWeights> = {
		insert: 5,
		remove: 5,
		move: 5,
		start: 1,
		commit: 1,
		// TODO: Enabling abort fails because aborting a transaction involves applying rollback ops, which may attempt to place
		// repair data content in places it already exists. This should be fixed by pending work to generate forest deltas
		// which destroy trees for rollbacks. See AB#6456 for more information.
		abort: 0,
		fieldSelection: { optional: 1, required: 1, sequence: 3, recurse: 3 },
	};
	const generatorFactory = () => takeAsync(opsPerRun, makeOpGenerator(editGeneratorOpWeights));
	/**
	 * This test suite is meant exercise all public APIs of SharedTree together, as well as all service-oriented
	 * operations (such as summarization and stashed ops).
	 */
	describe("Everything", () => {
		const model: DDSFuzzModel<
			SharedTreeTestFactory,
			Operation,
			DDSFuzzTestState<SharedTreeTestFactory>
		> = {
			workloadName: "SharedTree",
			factory: new SharedTreeTestFactory(onCreate),
			generatorFactory,
			reducer: fuzzReducer,
			validateConsistency: validateTreeConsistency,
		};
		const options: Partial<DDSFuzzSuiteOptions> = {
			...baseOptions,
			defaultTestCount: runsPerBatch,
			saveFailures: {
				directory: failureDirectory,
			},
			clientJoinOptions: {
				clientAddProbability: 0,
				maxNumberOfClients: 3,
			},
			// AB#7162: enabling rehydrate in these tests hits 0x744 and 0x79d. Disabling rehydrate for now
			// and using the default number of ops before attach.
			detachedStartOptions: {
				numOpsBeforeAttach: 5,
				rehydrateDisabled: true,
			},
			reconnectProbability: 0.1,
			idCompressorFactory: deterministicIdCompressorFactory(0xdeadbeef),
		};
		createDDSFuzzSuite(model, options);
	});

	describe("Batch rebasing", () => {
		const model: DDSFuzzModel<
			SharedTreeTestFactory,
			Operation,
			DDSFuzzTestState<SharedTreeTestFactory>
		> = {
			workloadName: "SharedTree rebasing",
			factory: new SharedTreeTestFactory(onCreate),
			generatorFactory,
			reducer: fuzzReducer,
			validateConsistency: validateTreeConsistency,
		};
		const options: Partial<DDSFuzzSuiteOptions> = {
			...baseOptions,
			reconnectProbability: 0.0,
			defaultTestCount: runsPerBatch,
			rebaseProbability: 0.2,
			containerRuntimeOptions: {
				flushMode: FlushMode.TurnBased,
				enableGroupedBatching: true,
			},
			// AB#7162: see comment above.
			detachedStartOptions: {
				numOpsBeforeAttach: 5,
				rehydrateDisabled: true,
			},
			saveFailures: {
				directory: failureDirectory,
			},
			idCompressorFactory: deterministicIdCompressorFactory(0xdeadbeef),
		};

		createDDSFuzzSuite(model, options);
	});
});
