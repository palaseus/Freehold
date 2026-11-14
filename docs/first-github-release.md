# First GitHub publication

Release candidate: 0.1.0, initial development release. All rights reserved under the root LICENSE. Both npm packages are private and UNLICENSED. This is not a production deployment or financial-services authorization.

## Publication contents

The publication branch contains application source, forward-only migrations, executable tests, lockfiles, current documentation, CI, and local deployment tooling. Historical phase reports, generated evidence, local credentials, logs, draft runners, and agent scratch files are kept outside the publication tree. Original development history is preserved locally on `master`; do not push it or use `git push --all` / `git push --mirror` for this release. The initial `main` branch intentionally starts with a curated root commit.

The historical tree contained a revoked disposable sandbox credential in a generated report and a literal example encryption key. Neither is included in the publication tree or its new history. The example now requires a user-generated key. Do not publish the retained development history without a separate sanitation review.

## Before pushing

1. Choose the GitHub repository owner/name and visibility. Keep it private unless public source visibility is explicitly intended; rights-reserved terms do not prevent others from reading a public repository.
2. Review `git status`, `git ls-tree -r --name-only main`, and the single-branch history. Confirm there are no environment files, backups, generated reports, or drafts.
3. Configure a remote only for the intended destination, then push **main only**:

   ```sh
   git remote add origin git@github.com:OWNER/REPOSITORY.git
   git push -u origin main
   ```

4. Enable private vulnerability reporting, assign a security response owner, enable secret scanning where available, and protect `main` with required pull requests and successful CI. Hosted CI must actually pass; local checks do not establish a GitHub Actions result.
5. After CI passes, review the changelog and create an annotated `v0.1.0` tag on the verified commit. Publish it as a development prerelease, with production acceptance still incomplete. Do not enable an open-source license or package publication.

No GitHub repository or remote is provisioned by these instructions. The owner must choose the destination before an external push. Retain local secret files for the running sandbox; they are intentionally absent from Git.
