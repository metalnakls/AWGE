/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** AWGM API URL - API base URL for your AWG Manager installation. */
  "apiBaseUrl": string,
  /** AWGM API Key - Only needed if AWGM web authorization is enabled. Use the API Key from AWGM Settings. */
  "apiKey"?: string,
  /** Default HR Neo Rule - Optional when only one HR Neo rule is enabled; set once if there are several. */
  "defaultRuleName"?: string,
  /** Router SSH Host - SSH host or alias from your SSH configuration. Required for storage commands. */
  "routerSshHost"?: string,
  /** TProxy Ruleset - Exact inline Sing-box ruleset name. Required for TProxy commands. */
  "tpRuleSetName"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `add-safari-domain` command */
  export type AddSafariDomain = ExtensionPreferences & {}
  /** Preferences accessible in the `add-to-tp` command */
  export type AddToTp = ExtensionPreferences & {}
  /** Preferences accessible in the `remove-safari-domain` command */
  export type RemoveSafariDomain = ExtensionPreferences & {}
  /** Preferences accessible in the `remove-from-tp` command */
  export type RemoveFromTp = ExtensionPreferences & {}
  /** Preferences accessible in the `add-to-zapret` command */
  export type AddToZapret = ExtensionPreferences & {}
  /** Preferences accessible in the `eject-router-drive` command */
  export type EjectRouterDrive = ExtensionPreferences & {}
  /** Preferences accessible in the `drive-settings` command */
  export type DriveSettings = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `add-safari-domain` command */
  export type AddSafariDomain = {}
  /** Arguments passed to the `add-to-tp` command */
  export type AddToTp = {}
  /** Arguments passed to the `remove-safari-domain` command */
  export type RemoveSafariDomain = {}
  /** Arguments passed to the `remove-from-tp` command */
  export type RemoveFromTp = {}
  /** Arguments passed to the `add-to-zapret` command */
  export type AddToZapret = {}
  /** Arguments passed to the `eject-router-drive` command */
  export type EjectRouterDrive = {}
  /** Arguments passed to the `drive-settings` command */
  export type DriveSettings = {}
}
