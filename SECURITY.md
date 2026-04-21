# Security Policy

## Supported Versions

OKN Studio is a single-deployment site; only the version running at the
production URL is actively maintained.

## Reporting a Vulnerability

Please **do not** file a public GitHub issue for security problems.

Email the maintainer privately with:

- A clear description of the issue.
- Steps to reproduce, ideally with a proof-of-concept request.
- The affected URL / endpoint / file.
- Your disclosure timeline expectations.

Expect an acknowledgement within a few business days. Critical
vulnerabilities (auth bypass, remote code execution, data exfiltration)
will be triaged immediately.

## Scope

In scope:

- `/_auth`, `/_logout`, `/_health` (Cloudflare Pages Functions in
  [functions/](functions/))
- `/api/analytics/upload`
- `/api/media/list`, `/api/media/download/*`
- The static site under [site/](site/) served behind the auth middleware
- Dependency / supply-chain concerns (`npm audit`, `pip-audit`)

Out of scope:

- Social engineering of maintainers.
- Denial of service via raw bandwidth.
- Self-XSS requiring pre-authenticated sessions + clipboard access.
- Issues in third-party services (Cloudflare, Backblaze, GitHub, esm.sh)
  unrelated to our configuration.

## Safe Harbor

Good-faith security research is welcome. We will not pursue legal action
against researchers who:

- Respect user privacy (no real-user data accessed beyond what's needed
  to demonstrate the issue).
- Give us reasonable time to fix before public disclosure.
- Do not destroy data or disrupt service.
