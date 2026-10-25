import { Toast, getPreferenceValues, showToast } from "@raycast/api";
import { execFile } from "node:child_process";
import { isIP } from "node:net";

type Preferences = {
  apiBaseUrl?: string;
  apiKey?: string;
  defaultRuleName?: string;
  tpRuleSetName?: string;
};

type HrRoute = {
  id: string;
  name: string;
  backend?: string;
  enabled: boolean;
};

type HrRouteDetail = HrRoute & {
  domains?: string[];
  manualDomains?: string[];
  routes?: Array<{ interface: string; tunnelId: string; fallback?: string }>;
  hrRouteMode?: "interface" | "policy";
  hrPolicyName?: string;
  hrPolicyInterfaces?: string[];
};

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: boolean;
  message?: string;
  code?: string;
};

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 5000, maxBuffer: 8192 }, (error, stdout) => {
      if (error) {
        reject(new Error("Could not read Safari's open page. Make sure Safari has a tab open and allow Raycast to control it."));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function getSafariURL(): Promise<string> {
  // Safari can replace a failed navigation's URL with its internal error URL. The
  // current-tab query works for regular pages; for the internal error page, inspect
  // its text and then fall back to Safari's visible address field.
  const pageURL = await runAppleScript('tell application "Safari" to get URL of current tab of front window');
  try {
    domainFromURL(pageURL);
    return pageURL;
  } catch {
    try {
      const pageText = await runAppleScript('tell application "Safari" to get text of current tab of front window');
      domainFromURL(pageText);
      return pageText;
    } catch {
      return runAppleScript('tell application "System Events" to tell process "Safari" to get value of text field 1 of toolbar 1 of window 1');
    }
  }
}

function normalizeDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

function domainFromURL(rawURL: string): string {
  const raw = rawURL.trim();
  const candidates = new Set<string>([raw]);
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.add(decoded);
  } catch {
    // Some browser error URLs contain percent-encoded copies of the requested URL.
  }

  for (const candidate of [...candidates]) {
    const embeddedWebURL = candidate.match(/https?:\/\/[^\s<>"']+/i)?.[0];
    if (embeddedWebURL) candidates.add(embeddedWebURL.replace(/[),.;]+$/, ""));
  }

  const nonPageSchemes = new Set(["about:", "blob:", "data:", "file:", "javascript:", "safari-extension:"]);
  for (const candidate of candidates) {
    let url: URL;
    try {
      const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(candidate);
      url = new URL(hasScheme ? candidate : "https://" + candidate);
    } catch {
      continue;
    }

    if (nonPageSchemes.has(url.protocol.toLowerCase())) continue;

    const domain = normalizeDomain(url.hostname);
    if (domain && domain !== "localhost" && !domain.endsWith(".localhost") && isIP(domain) === 0) {
      return domain;
    }
  }

  // Safari's failed-navigation text can mention only the host in its “server …”
  // sentence. Treat that specific label as the attempted host; do not guess from
  // unrelated words elsewhere in the error page.
  const failedServer = raw.match(/server\s+[“"']([^”"']+)[”"']/i)?.[1]?.trim();
  if (failedServer) {
    try {
      const hostname = normalizeDomain(new URL("https://" + failedServer).hostname);
      if (hostname && hostname !== "localhost" && !hostname.endsWith(".localhost") && isIP(hostname) === 0) {
        return hostname;
      }
    } catch {
      // Fall through to the standard unsupported-page error.
    }
  }

  throw new Error("Safari could not provide the site's address. Keep the failed site's address in the address bar and try again.");
}

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

class AwgmApiClient {
  private readonly baseURL: URL;
  private readonly apiKey: string;

  constructor(rawBaseURL: string, apiKey: string) {
    let baseURL: URL;
    try {
      baseURL = new URL(rawBaseURL.trim());
    } catch {
      throw new Error("Enter a valid AWGM API URL in this command's Raycast settings.");
    }
    if (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") {
      throw new Error("The AWGM API URL must use HTTP or HTTPS.");
    }
    if (baseURL.username || baseURL.password || baseURL.search || baseURL.hash) {
      throw new Error("The AWGM API URL must not contain credentials, a query, or a fragment.");
    }
    baseURL.pathname = baseURL.pathname.replace(/\/+$/, "") + "/";
    this.baseURL = baseURL;
    this.apiKey = apiKey.trim();
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ""), this.baseURL);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (this.apiKey) {
      headers.set("Authorization", "Bearer " + this.apiKey);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("Could not reach AWG Manager. Check its API URL and router connection.");
    }

    if (response.status === 404 || response.status === 405) {
      throw new ApiRequestError("AWG Manager does not support this API endpoint.", response.status);
    }

    let envelope: ApiEnvelope<T> | undefined;
    try {
      envelope = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new Error("AWG Manager returned an unreadable API response.");
    }

    if (!response.ok || envelope.error || envelope.success === false) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("AWG Manager requires web authorization. Add the AWGM API Key in AWGE settings.");
      }
      if (envelope.code === "HR_RULES_CHANGED") {
        if (path.startsWith("zapret/")) {
          throw new Error("Zapret's hostlist changed while this command was running. Run it again.");
        }
        throw new Error("HR Neo changed while this command was running. Run it again to use the latest rule list.");
      }
      if (response.status === 409 && path.startsWith("zapret/")) {
        throw new Error("Zapret's hostlist changed while this command was running. Run it again.");
      }
      throw new ApiRequestError(envelope.message || "AWG Manager rejected the API request (HTTP " + response.status + ").", response.status);
    }
    if (!("data" in envelope)) {
      throw new Error("AWG Manager returned an incomplete API response.");
    }
    return envelope.data as T;
  }
}

function hostnameCoveredBy(domain: string, entries: string[]): string | undefined {
  for (const entry of entries) {
    const candidate = entry.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (!candidate || candidate.includes("/") || candidate.includes(":")) {
      continue;
    }
    if (domain === candidate || domain.endsWith("." + candidate)) {
      return entry;
    }
  }
  return undefined;
}

function findConfiguredRoute(routes: HrRouteDetail[], configuredName: string): HrRouteDetail {
  const matches = routes.filter((route) => route.name.toLocaleLowerCase() === configuredName.toLocaleLowerCase());
  if (matches.length !== 1) {
    throw new Error('The saved HR Neo rule "' + configuredName + '" was not found uniquely. Update the rule name in AWGE settings.');
  }
  return matches[0];
}

function chooseDefaultRoute(routes: HrRouteDetail[], defaultRuleName?: string): HrRouteDetail {
  const configuredName = defaultRuleName?.trim();
  if (configuredName) {
    const route = findConfiguredRoute(routes, configuredName);
    if (!route.enabled) {
      throw new Error('The saved HR Neo rule "' + route.name + '" is disabled in AWG Manager.');
    }
    return route;
  }

  const enabledRoutes = routes.filter((route) => route.enabled);
  if (enabledRoutes.length === 1) {
    return enabledRoutes[0];
  }
  if (enabledRoutes.length === 0) {
    throw new Error("No enabled HR Neo rules were found in AWG Manager.");
  }
  throw new Error("More than one HR Neo rule is enabled. Set the default HR Neo rule once in AWGE settings.");
}

function normalizeExactDomain(entry: string): string {
  return normalizeDomain(entry.trim());
}

function hasExactManualDomain(route: HrRouteDetail, domain: string): boolean {
  return (route.manualDomains ?? []).some((entry) => normalizeExactDomain(entry) === domain);
}

function chooseRouteForRemoval(routes: HrRouteDetail[], domain: string, defaultRuleName?: string): HrRouteDetail {
  const configuredName = defaultRuleName?.trim();
  if (configuredName) {
    return findConfiguredRoute(routes, configuredName);
  }

  const matches = routes.filter((route) => hasExactManualDomain(route, domain));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error('This domain appears in more than one HR Neo rule. Set "Default HR Neo Rule" in Raycast settings to choose which one to remove it from.');
  }

  const enabledRoutes = routes.filter((route) => route.enabled);
  if (enabledRoutes.length === 1) {
    return enabledRoutes[0];
  }
  if (enabledRoutes.length === 0) {
    throw new Error("No enabled HR Neo rules were found in AWG Manager.");
  }
  throw new Error("More than one HR Neo rule is enabled. Set the default HR Neo rule in AWGE settings.");
}

export async function runSafariDomainAction(action: "add" | "remove") {
  const preferences = getPreferenceValues<Preferences>();
  const removing = action === "remove";
  try {
    const domain = domainFromURL(await getSafariURL());
    await showToast({ style: Toast.Style.Animated, title: removing ? "Removing from AWG" : "Adding to AWG", message: domain });

    const client = new AwgmApiClient(preferences.apiBaseUrl?.trim() || "", preferences.apiKey ?? "");
    const routes = await client.request<HrRouteDetail[]>("dns-routes/list");
    if (!Array.isArray(routes)) {
      throw new Error("AWG Manager returned an invalid HR Neo rule list.");
    }
    const hrRoutes = routes.filter((candidate) => candidate.backend === "hydraroute");
    const route = removing
      ? chooseRouteForRemoval(hrRoutes, domain, preferences.defaultRuleName)
      : chooseDefaultRoute(hrRoutes, preferences.defaultRuleName);
    // /dns-routes/get only resolves stored NDMS lists; HR Neo IDs are available
    // in the full /dns-routes/list response and should be updated from there.
    const detail = route;
    const manualDomains = detail.manualDomains ?? [];
    if (removing) {
      const matchingEntries = manualDomains.filter((entry) => normalizeExactDomain(entry) === domain);
      if (matchingEntries.length === 0) {
        throw new Error(domain + " is not an exact manual entry in " + route.name + ". This command only removes exact domains listed directly in the rule.");
      }

      await client.request<HrRouteDetail>("dns-routes/update?id=" + encodeURIComponent(route.id), {
        method: "POST",
        body: JSON.stringify({ ...detail, manualDomains: manualDomains.filter((entry) => normalizeExactDomain(entry) !== domain) }),
      });
      await showToast({
        style: Toast.Style.Success,
        title: "Removed from HR Neo",
        message: domain + " ← " + route.name,
      });
      return;
    }

    const hasLegacyWwwEntry = manualDomains.some((entry) =>
      normalizeExactDomain(entry) === domain && entry.trim().toLowerCase().replace(/\.$/, "") !== domain,
    );
    if (hasLegacyWwwEntry) {
      const canonicalManualDomains = manualDomains.filter((entry) => normalizeExactDomain(entry) !== domain);
      canonicalManualDomains.push(domain);
      await client.request<HrRouteDetail>("dns-routes/update?id=" + encodeURIComponent(route.id), {
        method: "POST",
        body: JSON.stringify({ ...detail, manualDomains: canonicalManualDomains }),
      });
      await showToast({
        style: Toast.Style.Success,
        title: "Updated in HR Neo",
        message: domain + " → " + route.name,
      });
      return;
    }

    const coveredBy = hostnameCoveredBy(domain, detail.domains ?? []);
    if (coveredBy) {
      await showToast({
        style: Toast.Style.Success,
        title: "Already in HR Neo",
        message: domain + " is covered by " + coveredBy + " in " + route.name + ".",
      });
      return;
    }

    const duplicate = hostnameCoveredBy(domain, manualDomains);
    if (duplicate) {
      await showToast({
        style: Toast.Style.Success,
        title: "Already in HR Neo",
        message: domain + " is covered by " + duplicate + " in " + route.name + ".",
      });
      return;
    }

    await client.request<HrRouteDetail>("dns-routes/update?id=" + encodeURIComponent(route.id), {
      method: "POST",
      // HR Neo updates need the current target metadata as well as the
      // replacement manual domain list. Sending only manualDomains makes
      // interface rules fail with "interface mode requires a tunnel".
      body: JSON.stringify({ ...detail, manualDomains: [...manualDomains, domain] }),
    });
    await showToast({
      style: Toast.Style.Success,
      title: "Added to HR Neo",
      message: domain + " → " + route.name,
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: removing ? "Could not remove from AWG" : "Could not add to AWG",
      message: error instanceof Error ? error.message : "AWG Manager returned an error.",
    });
  }
}

type ZapretHostlistInfo = {
  id: string;
  exists: boolean;
  editable: boolean;
  note?: string;
};

type ZapretHostlistsResponse = {
  hostlists: ZapretHostlistInfo[];
};

type ZapretHostlistContent = {
  id: string;
  content?: string;
  revision: string;
  restartError?: string;
};

export async function addSafariDomainToZapret() {
  try {
    const domain = domainFromURL(await getSafariURL());
    if (!/^[a-z0-9.-]+$/.test(domain)) {
      throw new Error("Safari's hostname is not a valid DNS name.");
    }
    await showToast({ style: Toast.Style.Animated, title: "Adding to Zapret", message: domain });

    const preferences = getPreferenceValues<Preferences>();
    const client = new AwgmApiClient(preferences.apiBaseUrl?.trim() || "", preferences.apiKey ?? "");
    const { hostlists } = await client.request<ZapretHostlistsResponse>("zapret/hostlists");
    if (!Array.isArray(hostlists)) {
      throw new Error("AWG Manager returned an invalid Zapret hostlist list.");
    }
    const userList = hostlists.find((list) => list.id === "user");
    if (!userList?.exists || !userList.editable) {
      throw new Error("Zapret's editable user hostlist is unavailable. Check that Zapret is installed and its user list exists.");
    }

    const list = await client.request<ZapretHostlistContent>("zapret/hostlist?id=user");
    const lines = (list.content ?? "").split(/\r?\n/);
    const existing = lines.find((line) => normalizeExactDomain(line) === domain);
    const alreadyPresent = Boolean(existing);
    const currentContent = list.content ?? "";
    const content = alreadyPresent
      ? currentContent
      : (currentContent.trimEnd() ? currentContent.trimEnd() + "\n" : "") + domain + "\n";
    const body = JSON.stringify({ id: "user", content, revision: list.revision });
    let saved: ZapretHostlistContent;
    try {
      saved = await client.request<ZapretHostlistContent>("zapret/hostlist/save", { method: "POST", body });
    } catch (error) {
      if (!(error instanceof ApiRequestError) || ![404, 405].includes(error.status)) throw error;
      saved = await client.request<ZapretHostlistContent>("zapret/hostlist", { method: "PUT", body });
    }
    if (saved.restartError) {
      throw new Error("Hostlist saved, but Zapret could not restart: " + saved.restartError);
    }

    await showToast({
      style: Toast.Style.Success,
      title: alreadyPresent ? "Already in Zapret" : "Added to Zapret",
      message: domain + " · AWG Manager applied the hostlist",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not add to Zapret",
      message: error instanceof Error ? error.message : "AWG Manager returned an error.",
    });
  }
}

type SingboxRuleSet = {
  tag: string;
  type: string;
  rules?: Array<Record<string, unknown>>;
  materialized_srs?: boolean;
  [key: string]: unknown;
};

type SingboxRouterSettings = {
  enabled?: boolean;
  routingMode?: string;
};

function findTpRuleSet(ruleSets: SingboxRuleSet[], configuredName?: string): SingboxRuleSet {
  const name = configuredName?.trim();
  if (!name) throw new Error("Set the TProxy Ruleset name in AWGE settings.");
  const matches = ruleSets.filter((ruleSet) => ruleSet.tag.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (matches.length !== 1 || matches[0].type !== "inline") {
    throw new Error("The configured Sing-box inline ruleset was not found uniquely in AWG Manager.");
  }
  return matches[0];
}

export async function addSafariDomainToTp() {
  try {
    const domain = domainFromURL(await getSafariURL());
    if (!/^[a-z0-9.-]+$/.test(domain)) {
      throw new Error("Safari's hostname is not a valid DNS name.");
    }
    await showToast({ style: Toast.Style.Animated, title: "Adding to TP", message: domain });

    const preferences = getPreferenceValues<Preferences>();
    const client = new AwgmApiClient(preferences.apiBaseUrl?.trim() || "", preferences.apiKey ?? "");
    const [routerSettings, ruleSets] = await Promise.all([
      client.request<SingboxRouterSettings>("singbox/router/settings"),
      client.request<SingboxRuleSet[]>("singbox/router/rulesets/list"),
    ]);
    if (!Array.isArray(ruleSets)) {
      throw new Error("AWG Manager returned an invalid Sing-box routing configuration.");
    }
    if (routerSettings.routingMode !== "tproxy") {
      throw new Error("Sing-box is not using TProxy routing in AWG Manager.");
    }
    const profile = findTpRuleSet(ruleSets, preferences.tpRuleSetName);
    const rules = profile.rules ?? [];
    const domainSuffixEntries = rules.flatMap((rule) => Array.isArray(rule.domain_suffix)
      ? rule.domain_suffix.filter((entry): entry is string => typeof entry === "string")
      : []);
    const coveredBy = hostnameCoveredBy(domain, domainSuffixEntries);
    if (coveredBy) {
      await showToast({ style: Toast.Style.Success, title: "Already in TP", message: domain + " is covered by " + coveredBy + " in " + profile.tag + "." });
      return;
    }

    const updatedRules = [...rules];
    const suffixRuleIndex = updatedRules.findIndex((rule) => Array.isArray(rule.domain_suffix));
    if (suffixRuleIndex >= 0) {
      updatedRules[suffixRuleIndex] = {
        ...updatedRules[suffixRuleIndex],
        domain_suffix: [...(updatedRules[suffixRuleIndex].domain_suffix as string[]), domain],
      };
    } else {
      updatedRules.push({ domain_suffix: [domain] });
    }
    const { materialized_srs: _materializedSrs, ...ruleSetForUpdate } = profile;
    await client.request("singbox/router/rulesets/update", {
      method: "POST",
      body: JSON.stringify({ tag: profile.tag, ruleSet: { ...ruleSetForUpdate, rules: updatedRules } }),
    });
    await showToast({
      style: Toast.Style.Success,
      title: "Added to TP",
      message: domain + " → " + profile.tag + " · applied by AWG Manager",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not add to TP",
      message: error instanceof Error ? error.message : "AWG Manager returned an error.",
    });
  }
}

export async function removeSafariDomainFromTp() {
  try {
    const domain = domainFromURL(await getSafariURL());
    if (!/^[a-z0-9.-]+$/.test(domain)) {
      throw new Error("Safari's hostname is not a valid DNS name.");
    }
    await showToast({ style: Toast.Style.Animated, title: "Removing from TP", message: domain });

    const preferences = getPreferenceValues<Preferences>();
    const client = new AwgmApiClient(preferences.apiBaseUrl?.trim() || "", preferences.apiKey ?? "");
    const [routerSettings, ruleSets] = await Promise.all([
      client.request<SingboxRouterSettings>("singbox/router/settings"),
      client.request<SingboxRuleSet[]>("singbox/router/rulesets/list"),
    ]);
    if (!Array.isArray(ruleSets)) {
      throw new Error("AWG Manager returned an invalid Sing-box routing configuration.");
    }
    if (routerSettings.routingMode !== "tproxy") {
      throw new Error("Sing-box is not using TProxy routing in AWG Manager.");
    }

    const profile = findTpRuleSet(ruleSets, preferences.tpRuleSetName);
    const rules = profile.rules ?? [];
    const exactEntries = rules.flatMap((rule) => Array.isArray(rule.domain_suffix)
      ? rule.domain_suffix.filter((entry): entry is string => typeof entry === "string" && normalizeExactDomain(entry) === domain)
      : []);
    if (exactEntries.length === 0) {
      const allSuffixEntries = rules.flatMap((rule) => Array.isArray(rule.domain_suffix)
        ? rule.domain_suffix.filter((entry): entry is string => typeof entry === "string")
        : []);
      const coveredBy = hostnameCoveredBy(domain, allSuffixEntries);
      if (coveredBy) {
        throw new Error(domain + " is covered by " + coveredBy + " in " + profile.tag + ", but is not an exact entry to remove.");
      }
      throw new Error(domain + " is not an exact entry in " + profile.tag + ".");
    }

    const updatedRules = rules.flatMap((rule) => {
      if (!Array.isArray(rule.domain_suffix)) return [rule];
      const remaining = rule.domain_suffix.filter((entry) => typeof entry !== "string" || normalizeExactDomain(entry) !== domain);
      if (remaining.length === rule.domain_suffix.length) return [rule];
      if (remaining.length > 0) return [{ ...rule, domain_suffix: remaining }];

      const { domain_suffix: _domainSuffix, ...otherMatchers } = rule;
      return Object.keys(otherMatchers).length > 0 ? [otherMatchers] : [];
    });
    const { materialized_srs: _materializedSrs, ...ruleSetForUpdate } = profile;
    await client.request("singbox/router/rulesets/update", {
      method: "POST",
      body: JSON.stringify({ tag: profile.tag, ruleSet: { ...ruleSetForUpdate, rules: updatedRules } }),
    });
    await showToast({
      style: Toast.Style.Success,
      title: "Removed from TP",
      message: domain + " ← " + profile.tag + " · applied by AWG Manager",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not remove from TP",
      message: error instanceof Error ? error.message : "AWG Manager returned an error.",
    });
  }
}
