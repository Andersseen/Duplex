# Security policy

Duplex handles live audio/video, screen content and — experimentally — remote control, so security
reports are taken seriously.

## Supported versions

Duplex has no versioned releases yet. Security fixes are applied to the `main` branch.

## Reporting a vulnerability

**Please do not open a public issue or pull request that describes a vulnerability.**

1. Use GitHub's **private vulnerability reporting**: on the repository's **Security** tab choose **Report a vulnerability**. This reaches the maintainer privately.
2. If that option is not available, open a public issue titled "Security contact request" that contains **no technical details**, and the maintainer will arrange a private channel.

Please include what you found, the affected component (web, Worker, helper), steps to reproduce,
and the impact you believe it has. Redact tokens, pairing codes and room links from anything you share.

You can expect an acknowledgement, a discussion of severity, and coordinated disclosure once a fix is
available. This is a small project maintained by an individual, so response times are best effort.

## Scope

In scope: room admission and origin checks, TURN credential handling, helper pairing and routing,
control-session consent and revocation, native input validation, the Tauri helper boundary, and the
web security headers.

Out of scope: social engineering of the person who clicks **Allow**, denial of service from sheer
traffic volume, issues that need a compromised local machine, and vulnerabilities in third-party
services (report those upstream). Native control is experimental and macOS-only.

For the security design and known gaps, see [docs/security.md](./docs/security.md).
