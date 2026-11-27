# Pine libraries

The Pine libraries a script can `import` on Atomik, one file per published version:
`pine-libs/<owner>/<Library>/<version>.pine`. A script line `import jdehorty/KernelFunctions/2 as kernels`
loads `jdehorty/KernelFunctions/2.pine`. Owner and library names match case-insensitively; the version must
match exactly.

PineTS has no library support, so `src/imports.mjs` inlines each imported library into the script before it
runs: the library's declarations (functions, methods, types, enums and the top-level values they use) go in
right after the script's `//@version` line, with `export` removed and every name prefixed per library, and
`alias.name` in the script becomes the prefixed name. The rest of a library's top level (its own example plots)
is dropped, as TradingView does for an imported library. Error lines and names are mapped back to what the user
wrote. A library that isn't in this folder is a compile error on the import line
("The Pine library x/Y/1 is not available on Atomik yet"), which the backend records with the other refused
scripts (`GET /api/v1/internal/pine/failures`), so the most requested libraries are easy to find.

Libraries are never fetched from TradingView at run time.

Known limits: a library runs under the importing script's `//@version`, not its own; exported methods keep their
name (they are called as `obj.method()`).

## Third-party libraries (unmodified)

These files are byte-for-byte the source TradingView publishes for that version, license header included.
`test/imports.test.mjs` pins their SHA-256, so an accidental edit fails the tests. They are distributed under
their own license, the Mozilla Public License 2.0 (each file's first line); MPL 2.0 allows that inside this
AGPL-3.0 project (MPL §3.3). Inlining them at run time does not change the files.

| Import path | Author | Published | TradingView page | Source | License | SHA-256 |
|---|---|---|---|---|---|---|
| `jdehorty/KernelFunctions/2` | © jdehorty | 2022-10-28 | [KernelFunctions](https://www.tradingview.com/script/e0Ek9x99-KernelFunctions/) | `PUB;29ad3e11fa7447d3bb82247b5e09288c`, version 2 | MPL 2.0 | `789b9405059a1ef3d306b18fe78b948344334559bcd56881b8f86caa31c90fce` |
| `jdehorty/MLExtensions/2` | © jdehorty | 2023-02-06 | [MLExtensions](https://www.tradingview.com/script/ia5ozyMF-MLExtensions/) | `PUB;d36c00024ee14427b1dd150b623962f9`, version 2 | MPL 2.0 | `e3e6ea0f030b6ee9c3742ba6e17ce9002ea8062c4b4ee618acfd58ba6c80a855` |

Both were fetched on 2026-11-27 from TradingView's published source for that publication and version.
`test/libraries.test.mjs` checks every exported function against an independent JavaScript port
(`test/reference/jdehorty.mjs`) on both `//@version=5` and `//@version=6` scripts.

## Atomik stand-ins

Atomik's own code, answering to an import path whose library is not open source. Each is written from the
function's described behaviour, never from the original's code, and provides only the functions listed.
Licensed with this repository (AGPL-3.0).

| Import path | Provides | Behaviour |
|---|---|---|
| `LuxSignals/FormattingUtils/3` | `textSizeFromChoice(choice)` | `"Tiny"`/`"Small"`/`"Normal"`/`"Large"` → `size.tiny`/`size.small`/`size.normal`/`size.large`; anything else → `size.normal`. Affects text size only. |

A script that calls a function a stand-in doesn't provide gets "… has no exported function or type named …"
on that line.

## Adding a library

1. Only an open-source library whose license allows redistribution (read the header of the exact version),
   or an Atomik stand-in written without looking at the original's code.
2. Save the exact published version as `<owner>/<Library>/<version>.pine`, unmodified.
3. Add it to the tables above (source, license, SHA-256) and to the hash and listing tests in
   `test/imports.test.mjs`.
4. If its functions drive trading logic, add a parity check like `test/libraries.test.mjs`.
