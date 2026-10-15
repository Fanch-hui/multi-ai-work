# Third-party notices

The project's Apache-2.0 license applies to its original code. Third-party
materials retain the licenses described below and in their own directories.

## Agent presets and skills

`resources/agent-presets/` includes adapted skills, examples, scripts and media.
Each skill directory contains its upstream `LICENSE` and `NOTICE`; its catalog
metadata records the source repository, commit and adaptation details.
These materials include MIT, Apache-2.0, CC BY-SA 4.0, BSD and Matplotlib
licenses. Preserve their attribution and license terms when redistributing or
modifying them. The project license does not replace those licenses.

Preset resource bytes are covered by catalog digests, including upstream
images and demonstration media. Keep the complete resource tree when building
or validating a preset package.

## Codex Bridge

The Qoder native adapter adapts the model catalog projection and the host-controlled
async input, account-scope, initialization, and result-boundary mechanisms from
Codex Bridge's `BridgeQoderSDK/Resources/QoderHost`.

Copyright 2026 Codex Bridge contributors.

- Source: https://github.com/Fanch-hui/codex-bridge
- Reference commit: `9f95e3c3caff67dba9467c22599b16d89d93cda8`
- License: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
- Changes: TypeScript adapter contracts, App-owned MCP policy and session ownership,
  per-turn precise resume, App profile isolation, and independent event projection.

## Runtime dependencies

- `@qodercn-ai/qodercn-agent-sdk`: Qoder SDK's distributed `LICENSE` applies; this package is consumed as a runtime dependency.
- `@vscode/ripgrep`: MIT-licensed package and platform binaries; ripgrep is distributed under MIT or the Unlicense. The dependency packages include their license notices.
- `ignore` and `cheerio`: MIT-licensed runtime dependencies; their distributed licenses apply.

Runtime package versions are pinned by the project dependency lockfile.

## Office and image runtime

- DSH Office structural checks: MIT notice in `licenses/office/DSH-MIT.txt`.
- Noto Sans CJK SC: SIL Open Font License in `licenses/office/Noto-OFL.txt`.
- The bundled Python, Node.js, Office libraries and LibreOffice engine retain their distributed licenses under the workspace runtime resources.
- `sharp` and its native dependencies retain their distributed license notices.
