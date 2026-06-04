# Azure DevOps access — the two doorways

sprint-helper talks to Azure DevOps through **one seam** (`server/ado-client.ts`), so the
same calls can run two ways, chosen by config:

| Mode  | How it authenticates                 | Setup for the user                  |
|-------|--------------------------------------|-------------------------------------|
| `cli` | Your `az login` session (default)    | Have the Azure CLI installed + logged in |
| `api` | A token stored locally               | Paste a token once at install       |

**Why two:** the CLI is zero-setup if you already use `az`, but it assumes the Azure CLI is
on the machine. A tool meant for other developers can't assume that — the direct-API mode
works anywhere, at the cost of pasting a token. Decision recorded in Claude's memory
(`project_portability_config.md`); Moran's call was "support both, choose by config."

## The seam

`AdoClient.rest({ method, uri, body?, contentKind? })` runs one REST request and returns the
parsed JSON. Callers build a full URI (org/project already in it) and a JSON body; the client
owns authentication and transport.

- **`CliAdoClient`** shells out to `az rest` (the long-standing behaviour).
- **`RestAdoClient`** *(later step)* calls the API directly with a stored token.

## What still needs per-mode work

Most calls are plain REST and swap cleanly. Two CLI conveniences bundle extra work that the
direct-API path must reproduce itself:

- **`az boards query --wiql`** returns work items with their fields already populated. The raw
  REST API splits this: POST `_apis/wit/wiql` returns only ids, then `workitemsbatch` hydrates
  them. The API doorway does both.
- **Config discovery** (`az devops configure --list`, `az account show`) is CLI-only; in API
  mode org/project/team/user come from stored config instead.

## The token (API mode)

The direct-API mode needs an Azure DevOps token (a Personal Access Token with work-item
read/write). It's a **secret**: stored locally, never echoed back in chat — same handling as
the Outlook calendar URL. Generating it is a one-time setup step covered in the README/setup.

## Status

- [x] Step 1 — the seam + `CliAdoClient` (behaviour-preserving).
- [ ] Step 2 — migrate all `az rest` call sites onto the seam.
- [ ] Step 3 — `RestAdoClient` (direct API + token) and WIQL/iteration REST equivalents.
- [ ] Step 4 — config switch for the mode + where the token lives.
