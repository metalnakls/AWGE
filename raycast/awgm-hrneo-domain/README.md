# AWGE for Raycast

Manage AWG Manager routing from Safari’s current tab and USB storage connected to a Keenetic router.

## Setup

1. Run `npm ci`, then `npm run dev` to import the extension into Raycast. `npm run build` builds the commands; `npm test` runs offline checks.
2. Set **AWGM API URL** to your installation’s API base URL. If web authorization is enabled, enter its API key in the password preference.
3. Set **Default HR Neo Rule** if more than one rule is enabled.
4. Set **TProxy Ruleset** to the exact inline Sing-box ruleset to manage.
5. For storage commands, set **Router SSH Host** to a host or alias in your SSH configuration. Authentication uses your existing SSH keys.

## Commands

- **add to HR** / **remove from HR** update manual domains while preserving the routing target and policy metadata.
- **add to TP** / **remove from TP** update the configured inline TProxy ruleset. Removal only affects exact entries, preserving parent-domain coverage.
- **add to zapret** updates the editable user hostlist through AWG Manager. Uses the current POST save API, with a fallback for older releases.
- **eject drive** unmounts one partition while keeping the USB device connected. It asks for confirmation, warns about active services, and verifies the partition is unmounted.
- **drive settings** stores partition locks locally in Raycast. Unknown partitions start locked; unlock a partition explicitly before disconnecting it.

Routing commands read Safari’s current address, including failed navigation pages. Domain commands require macOS automation permission for Raycast to read Safari.

## Privacy

Router addresses, SSH hosts, API keys, routing rule names, and drive lock states belong in local preferences or Raycast storage. The source contains no personal connection defaults or drive names. Never commit exported preferences, SSH keys, router responses, or development bundles.
