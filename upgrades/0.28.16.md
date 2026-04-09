## What Changed

- **Fixed Homebrew installer failing on admin accounts.** The previous version used NONINTERACTIVE mode which prevented the sudo password prompt, causing installation to fail even on admin accounts with a misleading "needs to be an Administrator" error. Now stdio is inherited so the user can enter their password when prompted. Timeout also increased to 10 minutes to accommodate Xcode Command Line Tools installation.

## What to Tell Your User

Nothing — this is a fix to the setup experience. Installing on a fresh Mac will now correctly prompt for the password instead of failing silently.

## Summary of New Capabilities

No new capabilities — bug fix to Homebrew auto-install from 0.28.13.
