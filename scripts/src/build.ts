/**
 * INITx Protocol — Build WASM artifacts for all 5 contracts
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "../..");
const ARTIFACTS_DIR = resolve(ROOT, "artifacts");

const CONTRACTS = [
  "initx-token",
  "staking",
  "lp-pool",
  "lending",
  "governance",
];

function build() {
  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  console.log("Building all contracts in release mode...\n");

  execSync(
    `source ~/.cargo/env && cargo build --release --target wasm32-unknown-unknown`,
    { cwd: ROOT, stdio: "inherit", shell: "/bin/bash" }
  );

  // Copy and optionally optimize WASM files
  for (const name of CONTRACTS) {
    const crateNameUnderscored = name.replace(/-/g, "_");
    const wasmSource = resolve(
      ROOT,
      `target/wasm32-unknown-unknown/release/${crateNameUnderscored}.wasm`
    );
    const wasmDest = resolve(ARTIFACTS_DIR, `${crateNameUnderscored}.wasm`);

    if (!existsSync(wasmSource)) {
      console.error(`WASM not found: ${wasmSource}`);
      process.exit(1);
    }

    execSync(`cp "${wasmSource}" "${wasmDest}"`);
    console.log(`  ✓ ${name} -> artifacts/${crateNameUnderscored}.wasm`);
  }

  console.log("\nAll artifacts built successfully.");
}

build();
