---
name: create-pr
description: 'Create a GitHub pull request from the current branch. Use when: you have commits ready on a feature branch and need to open a PR, submit code for review, or propose changes to the main branch.'
argument-hint: 'Optional PR title (e.g., "fix: resolve login issue")'
user-invocable: true
---

# Create Pull Request

## When to Use

- You have a feature branch with commits that are ready for review
- You want to submit code changes to the main branch
- You need to create a PR through the CLI instead of the GitHub web interface
- Your branch is already pushed to `origin`

## Prerequisites

- Git repository with a feature branch checked out
- Changes committed and pushed to remote
- GitHub CLI (`gh`) installed and authenticated (`gh auth login`)

## Procedure

### 1. Verify Current Branch

Check that you're on the correct feature branch:

```bash
git status
```

Expected output: `On branch <feature-branch>`

### 2. Ensure Changes Are Pushed

Push your commits to the remote if not already done:

```bash
git push origin <branch-name>
```

### 3. Authenticate with GitHub CLI

If not already authenticated, run:

```bash
gh auth login
```

Follow the prompts:
- Select **GitHub.com**
- Choose **HTTPS** for protocol
- Answer **Yes** to authenticate Git
- Select **Login with a web browser**
- Copy the device code (e.g., `DDBE-402E`)
- Open the link and enter the code to complete authentication

### 4. Create the Pull Request

Run the create PR command:

```bash
gh pr create --head <branch-name>
```

Or use the shorthand if on the branch already:

```bash
gh pr create
```

### 5. Fill in PR Details

The CLI will prompt you for:
- **Title** (required): A clear description of the changes
  - Use conventional commits format when possible: `feat:`, `fix:`, `docs:`, etc.
  - Example: `feat: remove file limit and add copy button`
- **Body** (optional): Detailed description of what changed and why
  - Press `e` to open your default editor for longer descriptions
  - Press Enter to skip if you'll add details later
- **Submit options**:
  - **Submit**: Create the PR immediately
  - **Submit as draft**: Create as a draft PR (reviewer can request changes)
  - **Continue in browser**: Open GitHub to make additional changes
  - **Add metadata**: Configure labels, assignees, reviewers

## Examples

### Simple PR with CLI defaults

```bash
gh pr create --head files-limit
```

Then follow the prompts for title and description.

### PR with explicit title and body

```bash
gh pr create --head feature-branch --title "fix: resolve login issue" --body "Fixes session validation bug"
```

### Draft PR

```bash
gh pr create --head feature-branch --draft
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `gh: command not found` | Install GitHub CLI: `choco install gh` (Windows) or `brew install gh` (macOS) |
| `authentication required` | Run `gh auth login` and complete the device code flow |
| `branch not found on remote` | Push with `git push origin <branch-name>` first |
| `PR already exists` | Check GitHub for an existing PR from this branch |

## Related Commands

- View pull requests: `gh pr list`
- View a specific PR: `gh pr view <pr-number>`
- Check PR status: `gh pr status`
- Close a PR: `gh pr close <pr-number>`
