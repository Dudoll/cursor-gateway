#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { parseConfig, usage } from "./config.js";
import {
  CsapiHttpClient,
  HttpEvidenceObserver,
  RealClock
} from "./http.js";
import {
  buildReport,
  humanSummary,
  readRunIds,
  reportSecrets,
  writeReport
} from "./report.js";
import {
  runAcceptanceScenarios,
  runLongScenario,
  runObservationScenario
} from "./scenarios.js";
import {
  ConfigurationError,
  type ScenarioDependencies,
  type ScenarioResult
} from "./types.js";

async function main(argv: string[]): Promise<number> {
  const parsed = parseConfig(argv);
  if ("help" in parsed) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const clock = new RealClock();
  const client = new CsapiHttpClient(parsed, clock);
  const observer = parsed.observer
    ? new HttpEvidenceObserver(
        parsed.observer,
        parsed.expectedProvider,
        parsed.expectedModel
      )
    : null;
  const dependencies: ScenarioDependencies = {
    client,
    observer,
    clock,
    randomId: randomUUID
  };
  const startedAtMs = clock.now();
  let scenarios: ScenarioResult[];
  switch (parsed.command) {
    case "accept":
      scenarios = await runAcceptanceScenarios(parsed, dependencies);
      break;
    case "long":
      scenarios = [await runLongScenario(parsed, dependencies)];
      break;
    case "observe": {
      if (!parsed.inputPath) {
        throw new ConfigurationError(
          "MISSING_INPUT",
          "observe requires --input with a prior result JSON file"
        );
      }
      const runIds = await readRunIds(parsed.inputPath);
      scenarios = [
        await runObservationScenario(runIds, parsed, dependencies)
      ];
      break;
    }
  }
  const report = buildReport(parsed, scenarios, startedAtMs, clock.now());
  await writeReport(report, parsed.outputPath, reportSecrets(parsed));
  process.stderr.write(`${humanSummary(report)}\n`);
  return report.passed ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`CONFIG ${error.code}: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    const category =
      error instanceof Error && error.name ? error.name : "UnexpectedError";
    process.stderr.write(`ERROR ${category}; no secret-bearing details emitted\n`);
    process.exitCode = 3;
  });
