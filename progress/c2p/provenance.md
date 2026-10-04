# c2p provenance: vendored and reference sources

Both sources are nested git repositories inside this checkout. They are listed
in `.gitignore` and are never committed. Pin and verify them by SHA.

| Source | Pinned SHA | Origin | License | Local path | Tracked here | Role |
|---|---|---|---|---|---|---|
| Chandra | `a77b28d0f80dffe38a59224de35e507bc72024d9` | https://github.com/FoAKTEE/Chandra.git | MIT | `Chandra/` | no (gitignored) | Conventions and commit gate only (decisions D4). Supplies `_common/hooks/commit-msg`, `_common/contracts/commit_template.md`, `.gitmessage`, and the delegation-launcher conventions for the thinker role |
| MiroFish | `7657031ac01184afe2cb220f5ee3545573b5e843` | https://github.com/666ghj/MiroFish.git | AGPL-3.0 | `ref-code/MiroFish/` | no (gitignored) | Read-only reference; patterns are reimplemented, never copied (decisions D1) |

## Restore and verify

From the repo root:

```bash
# Chandra
git clone https://github.com/FoAKTEE/Chandra.git Chandra
git -C Chandra checkout a77b28d0f80dffe38a59224de35e507bc72024d9
git -C Chandra rev-parse HEAD   # expect a77b28d0f80dffe38a59224de35e507bc72024d9

# MiroFish
mkdir -p ref-code
git clone https://github.com/666ghj/MiroFish.git ref-code/MiroFish
git -C ref-code/MiroFish checkout 7657031ac01184afe2cb220f5ee3545573b5e843
git -C ref-code/MiroFish rev-parse HEAD   # expect 7657031ac01184afe2cb220f5ee3545573b5e843
```

## Commit-gate wiring

Run from this repo's root. Do not use `Chandra/_common/hooks/install.sh`: it
sets `core.hooksPath=_common/hooks` relative to the repo root, a path that does
not exist in this layout (decisions D4).

```bash
git config core.hooksPath Chandra/_common/hooks && git config commit.template Chandra/.gitmessage
```

Check: `bash Chandra/_common/hooks/commit-msg <file>` exits 1 for the title
`bad title` and 0 for `feat(core): add smoke test`.
