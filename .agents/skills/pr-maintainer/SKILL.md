---
name: pr-maintainer
description: Maintain agent-created style-bert-vits2-bridge pull requests after creation or draft-to-ready transition: mark reviewable drafts ready, poll CI and review comments with gh, repair failures in the same worktree, reply in Japanese, escalate design loops, and squash merge when safe.
metadata:
  short-description: style-bert-vits2-bridge PR の CI/レビュー監視、修正、返信、squash merge を運用する。
---

# PR Maintainer

Use this skill after an agent creates a `NEXTAltair/style-bert-vits2-bridge` PR, or when asked to continue PR maintenance through CI, review comments, repair commits, and merge.

## Core Policy

- Continue in the same dedicated worktree used to create the PR, usually `/tmp/style-bert-vits2-bridge-issue-*`.
- Agent-created PRs should be ready for review by default. If a reviewable PR is draft only because of publication defaults, mark it ready before polling.
- Use `gh` / `gh api` for PR state, checks, logs, comments, reactions, replies, and merge.
- Do not use GitHub comment-driven repair commands such as `@codex fix`.
- Poll for at most 20 minutes, every 3 minutes.
- Repair CI failures and actionable review findings in the same PR worktree.
- Reply to every review comment in Japanese.
- Do not auto-resolve review threads.
- Allow up to 4 repair loops, then escalate.
- Merge only when CI is clean, bot review has completed cleanly, the PR is not draft, and the head SHA still matches.
- Use squash merge with branch deletion.
- After merge, remove the merged `/tmp/style-bert-vits2-bridge-issue-*` worktree from outside that worktree.

## No-Draft Postcondition

After opening or resuming a PR:

```bash
IS_DRAFT="$(gh pr view "$PR" --json isDraft -q .isDraft)"
if [ "$IS_DRAFT" = "true" ]; then
  gh pr ready "$PR"
fi

IS_DRAFT="$(gh pr view "$PR" --json isDraft -q .isDraft)"
if [ "$IS_DRAFT" = "true" ]; then
  echo "PR is still draft; aborting auto-merge setup."
  exit 1
fi
```

Leave a PR draft only when the user explicitly asked for draft-only publication, local validation is incomplete or failing, the scope is intentionally not ready, or a blocker must be reported.

## Polling Workflow

Record the PR number and current head SHA in session memory, then loop until success, repair-needed, escalation, timeout, or merge.

Gather state:

```bash
gh pr view "$PR" --json \
  number,title,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup,labels

gh pr checks "$PR" --json name,state,bucket,link,startedAt,completedAt,workflow
```

Review completion gate:

- Do not merge immediately after CI success.
- Continue polling until an expected Codex/Bot review artifact appears as a PR review, review comment, issue comment, issue reaction, or repository-standard bot review artifact.
- A `+1` reaction from `chatgpt-codex-connector[bot]` on the PR issue counts as a completed clean bot review when there are no blocking review comments.
- If CI is green but no bot review artifact appears within 20 minutes, comment in Japanese that CI is green but review did not complete within the polling window, then stop without merging.

Gather clean-reaction state:

```bash
gh api "repos/NEXTAltair/style-bert-vits2-bridge/issues/$PR/reactions"
```

For failed CI jobs, fetch failed logs:

```bash
gh run view "$RUN_ID" --log-failed
```

Keep large API responses and logs bounded; summarize before reasoning over them.

## Repair Rules

When CI fails or review comments require changes:

1. Read failed logs and review comments.
2. Decide whether each finding is valid.
3. Apply the smallest coherent fix in the existing PR worktree.
4. Run the normal validation:

   ```bash
   pnpm run check
   pnpm test
   pnpm run build
   ```

5. Commit and push the repair.
6. Reply to every review comment in Japanese.

Reply format for code changes:

```markdown
対応しました。

- 修正内容: ...
- 修正commit: ...
- 検証: `pnpm run check`, `pnpm test`, `pnpm run build` passed
```

Reply format when no code change is needed:

```markdown
この指摘は対応不要と判断しました。

- 理由: ...
- 確認内容: ...
```

## Escalation Rules

Stop automatic repair and escalate when:

- The 4th repair attempt still does not clear CI or review findings.
- Review comments recur in the same responsibility boundary after a repair.
- The fix requires workflow, permission, secret, or environment changes.
- The fix requires direct push to `main` or history rewriting.
- The fix requires a large design change rather than local repair.

Allowed in automatic repair:

- TypeScript source changes
- Tests
- README or skill documentation
- Package metadata and lockfile updates

Not allowed in automatic repair:

- `.github/workflows/**` changes
- GitHub Actions permission changes
- Secret or environment configuration changes
- Direct push to `main`
- Git history rewriting
- Large design rewrites

On escalation:

1. Add design/escalation labels to the PR when available.
2. Create a GitHub issue describing the design problem and options.
3. Comment on the PR in Japanese with the issue link, summary, options, and needed user decision.
4. Stop without merging.

## Merge Rules

Before merge, verify:

- PR is not draft.
- Head SHA matches the last checked SHA.
- Required checks are successful.
- Bot review has completed and has no blocking findings.
- PR reviews/comments/reactions contain an expected bot review artifact.
- Repair loop count is below the escalation threshold.
- PR is not in escalation state.

Then run:

```bash
gh pr merge "$PR" --squash --auto --delete-branch --match-head-commit "$HEAD_SHA"
```

After GitHub reports the PR merged, remove the merged worktree from outside it:

```bash
git worktree remove "$WORKTREE_PATH"
```

Do not remove unrelated worktrees or the shared checkout.
