## What and why

<!-- What does this change, and why? Link the issue it closes, e.g. "Closes #123". -->

## How it was tested

<!-- Commands run, new tests added, manual checks. -->

## Checklist

- [ ] `npm run typecheck`, `npm run build`, `npm test` and `npm run test:e2e -w apps/gateway` pass
- [ ] Provider logic lives only in an adapter
- [ ] No mutation of `transactions` or the audit tables
- [ ] New enforcement behaviour defaults to soft/alert-only
- [ ] Non-critical writes don't block the response path
- [ ] Schema changes come with a migration
- [ ] New routes are in the OpenAPI table and have tests (including tenant isolation)
- [ ] README "What works today" / "Known gaps" updated if behaviour changed
- [ ] No unverified claims in docs or copy
- [ ] I have signed the [CLA](https://github.com/Complete-tokenistt/tokenist-main/blob/main/CLA.md) (the CLA bot will prompt you on your first PR)
