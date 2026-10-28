// TF-032: deklarative Anbieter- und Zugangs-Registry.
// Kein Profil ermächtigt zu einer Verbindung oder Reparatur. CUSTOM bleibt immer manuell.

export const ACCESS_METHODS = Object.freeze([
  "github_netlify", "wordpress_cms", "sftp", "ssh", "hosting", "other",
  "cms_admin", "hosting_panel", "git_repository", "api_access", "oauth_connection", "team_invitation", "cloud_iam",
]);

export const ACCESS_METHOD_FORMS = Object.freeze({
  github_netlify: ["host", "user", "notes"], wordpress_cms: ["host", "user", "secret", "notes"],
  sftp: ["host", "port", "user", "secret", "root", "hostKey", "passphrase", "provider", "notes"],
  ssh: ["host", "port", "user", "secret", "root", "hostKey", "passphrase", "provider", "notes"],
  hosting: ["host", "user", "secret", "provider", "notes"], other: ["host", "user", "secret", "provider", "notes"],
  cms_admin: ["host", "user", "secret", "provider", "notes"], hosting_panel: ["host", "user", "secret", "provider", "notes"],
  git_repository: ["host", "user", "notes"], api_access: ["host", "secret", "provider", "notes"],
  oauth_connection: ["host", "user", "provider", "notes"], team_invitation: ["host", "user", "provider", "notes"],
  cloud_iam: ["host", "user", "provider", "notes"],
});

const manual = (id, name, access_types = ACCESS_METHODS) => ({ id, name, access_types, automation: "manual", adapter_keys: [] });
const adapter = (id, name, adapter_keys, access_types) => ({ id, name, access_types, automation: "adapter", adapter_keys });

export const PROVIDER_REGISTRY = Object.freeze({
  CUSTOM: manual("CUSTOM", "Individueller Anbieter"),
  WORDPRESS: adapter("WORDPRESS", "WordPress", ["wordpress"], ["wordpress_cms", "cms_admin", "sftp", "ssh", "hosting", "hosting_panel"]),
  SFTP_HOSTING: adapter("SFTP_HOSTING", "SFTP-/SSH-Hosting", ["sftp", "ssh"], ["sftp", "ssh", "hosting"]),
  WOOCOMMERCE: adapter("WOOCOMMERCE", "WooCommerce", ["wordpress"], ["wordpress_cms", "cms_admin", "sftp", "ssh", "hosting", "hosting_panel"]),
  NETLIFY: adapter("NETLIFY", "Netlify", ["github_netlify"], ["github_netlify", "git_repository", "team_invitation"]),
  GITHUB: adapter("GITHUB", "GitHub", ["github_netlify"], ["github_netlify", "git_repository", "team_invitation"]),
  SHOPIFY: manual("SHOPIFY", "Shopify", ["team_invitation", "api_access", "other"]),
  WIX: manual("WIX", "Wix", ["team_invitation", "other"]),
  SQUARESPACE: manual("SQUARESPACE", "Squarespace", ["team_invitation", "other"]),
  WEBFLOW: manual("WEBFLOW", "Webflow", ["team_invitation", "api_access", "other"]),
  JOOMLA: manual("JOOMLA", "Joomla", ["cms_admin", "sftp", "ssh", "hosting_panel", "other"]),
  DRUPAL: manual("DRUPAL", "Drupal", ["cms_admin", "sftp", "ssh", "hosting_panel", "other"]),
  TYPO3: manual("TYPO3", "TYPO3", ["cms_admin", "sftp", "ssh", "hosting_panel", "other"]),
  MAGENTO: manual("MAGENTO", "Magento / Adobe Commerce", ["cms_admin", "sftp", "ssh", "hosting_panel", "other"]),
  PRESTASHOP: manual("PRESTASHOP", "PrestaShop", ["cms_admin", "sftp", "ssh", "hosting_panel", "other"]),
  SHOPWARE: manual("SHOPWARE", "Shopware", ["cms_admin", "sftp", "ssh", "hosting_panel", "other"]),
  BIGCOMMERCE: manual("BIGCOMMERCE", "BigCommerce", ["team_invitation", "api_access", "other"]),
  JIMDO: manual("JIMDO", "Jimdo", ["team_invitation", "other"]),
  IONOS: manual("IONOS", "IONOS", ["hosting_panel", "sftp", "ssh", "other"]),
  HOSTPOINT: manual("HOSTPOINT", "Hostpoint", ["hosting_panel", "sftp", "ssh", "other"]),
  INFOMANIAK: manual("INFOMANIAK", "Infomaniak", ["hosting_panel", "sftp", "ssh", "other"]),
  GODADDY: manual("GODADDY", "GoDaddy", ["hosting_panel", "sftp", "ssh", "other"]),
  SITEGROUND: manual("SITEGROUND", "SiteGround", ["hosting_panel", "sftp", "ssh", "other"]),
  BLUEHOST: manual("BLUEHOST", "Bluehost", ["hosting_panel", "sftp", "ssh", "other"]),
  HOSTINGER: manual("HOSTINGER", "Hostinger", ["hosting_panel", "sftp", "ssh", "other"]),
  CLOUDFLARE: manual("CLOUDFLARE", "Cloudflare", ["team_invitation", "api_access", "oauth_connection", "other"]),
  VERCEL: manual("VERCEL", "Vercel", ["team_invitation", "git_repository", "other"]),
  AWS: manual("AWS", "AWS", ["cloud_iam", "team_invitation", "oauth_connection", "other"]),
  AZURE: manual("AZURE", "Azure", ["cloud_iam", "team_invitation", "oauth_connection", "other"]),
  GOOGLE_CLOUD: manual("GOOGLE_CLOUD", "Google Cloud", ["cloud_iam", "team_invitation", "oauth_connection", "other"]),
  GITLAB: manual("GITLAB", "GitLab", ["git_repository", "team_invitation", "api_access", "other"]),
});

const DETECTION_ALIASES = Object.freeze({ GITHUB_PAGES: "GITHUB", CLOUDFLARE_PAGES: "CLOUDFLARE", GOOGLE: "GOOGLE_CLOUD" });
const profileId = (value) => {
  const id = String(value || "").trim().toUpperCase();
  return PROVIDER_REGISTRY[id] ? id : (DETECTION_ALIASES[id] || "CUSTOM");
};

export const providerProfileForDetection = (d = {}) => {
  for (const candidate of [d.cms_platform, d.deployment_platform, d.hosting_provider, d.dns_provider]) {
    const id = profileId(candidate);
    if (id !== "CUSTOM") return PROVIDER_REGISTRY[id];
  }
  return PROVIDER_REGISTRY.CUSTOM;
};

// TF-033: Erkennung bleibt ein Vorschlag. Nur ein einzelnes HIGH-Signal darf
// automatisch vorselektieren; widersprüchliche oder schwache Signale verlangen
// eine Bestätigung des Kunden und werden nie als Reparaturfreigabe verwendet.
export const detectProviderSuggestion = (d = {}) => {
  const fields = [
    ["cms_platform", d.cms_platform, d.cms_confidence],
    ["deployment_platform", d.deployment_platform, d.deployment_confidence],
    ["hosting_provider", d.hosting_provider, d.hosting_confidence],
  ];
  const high = fields.map(([evidence, value, confidence]) => ({ evidence, id: profileId(value), confidence }))
    .filter((x) => x.confidence === "HIGH" && x.id !== "CUSTOM");
  const present = fields.filter(([, value]) => value != null && String(value).trim()).map(([evidence]) => evidence);
  const ids = [...new Set(high.map((x) => x.id))];
  if (ids.length === 1) return { provider_id: ids[0], status: "DETECTED", confidence: "HIGH", evidence: [high[0].evidence] };
  return { provider_id: "CUSTOM", status: "PROVIDER_VERIFICATION_REQUIRED", confidence: "UNKNOWN", evidence: present.slice(0, 4) };
};

export const cleanProviderName = (value) => {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= 120 ? name : null;
};

export const resolveProviderSelection = ({ provider_id = "CUSTOM", provider_name = null, access_type = null } = {}) => {
  const id = profileId(provider_id);
  const profile = PROVIDER_REGISTRY[id];
  if (!ACCESS_METHODS.includes(access_type) || !profile.access_types.includes(access_type)) return null;
  if (id === "CUSTOM") {
    const name = cleanProviderName(provider_name);
    if (!name) return null;
    return { provider_id: id, provider_name: name, access_type, automation: "manual" };
  }
  return { provider_id: id, provider_name: profile.name, access_type, automation: profile.automation };
};

export const publicProviderProfile = (profile) => profile && PROVIDER_REGISTRY[profile.id]
  ? { id: profile.id, name: profile.name, access_types: profile.access_types, automation: profile.automation }
  : null;

export const profileCanAutoRepair = (selection, adapters = {}) => {
  const profile = PROVIDER_REGISTRY[selection?.provider_id];
  return selection?.automation === "adapter" && profile?.automation === "adapter"
    && profile.adapter_keys.some((key) => typeof adapters[key]?.checkAccess === "function");
};

export const profileCanUseAdapter = (selection, adapterKey, adapters = {}) => {
  const profile = PROVIDER_REGISTRY[selection?.provider_id];
  return profileCanAutoRepair(selection, adapters) && profile.adapter_keys.includes(adapterKey)
    && typeof adapters[adapterKey]?.checkAccess === "function";
};
