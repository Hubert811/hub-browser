/**
 * CLI discovery: finds JS CLI definitions and registers them.
 *
 * Supports two modes:
 * 1. FAST PATH (manifest): If a pre-compiled cli-manifest.json exists,
 *    registers commands instantly. JS modules are loaded lazily only
 *    when their command is executed.
 * 2. FALLBACK (filesystem scan): Traditional runtime discovery for development.
 *
 * User data root (方案 C): product-owned ~/.hub (overridable via
 * BROWSEROS_DIR). The `clis/` adapter directory keeps the opencli naming.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Strategy, registerCommand } from './registry.js';
import { getErrorMessage } from './errors.js';
import { log } from './logger.js';
import { snapshotHooks, restoreHooks } from './hooks.js';
import { findPackageRoot, getCliManifestPath } from './package-paths.js';
/**
 * Single user-data root (方案 C): `~/.hub` by default, overridable via
 * `BROWSEROS_DIR`. This is the only place the JS engine fork resolves the
 * root; src/space/task-space-manager.ts keeps an identical inline copy
 * (TS side is deliberately zero-relative-import, so no cross-package import).
 */
export function hubUserRoot() {
    const override = process.env.BROWSEROS_DIR?.trim();
    if (override)
        return override;
    return path.join(os.homedir(), '.hub');
}
/** User runtime directory: <root> (~/.hub) */
export const USER_OPENCLI_DIR = hubUserRoot();
/** User CLIs directory: <root>/clis (opencli adapter naming retained) */
export const USER_CLIS_DIR = path.join(USER_OPENCLI_DIR, 'clis');
/** Plugins directory: <root>/plugins */
export const PLUGINS_DIR = path.join(USER_OPENCLI_DIR, 'plugins');
/** Legacy user CLIs directory (pre-方案 C): ~/.opencli/clis — migration source only. */
const LEGACY_USER_CLIS_DIR = path.join(os.homedir(), '.opencli', 'clis');
/** Matches files that register commands via cli() or lifecycle hooks */
const PLUGIN_MODULE_PATTERN = /\b(?:cli|registerSiteAuthCommands|onStartup|onBeforeExecute|onAfterExecute)\s*\(/;
function parseStrategy(rawStrategy, fallback = Strategy.COOKIE) {
    if (!rawStrategy)
        return fallback;
    const key = rawStrategy.toUpperCase();
    return Strategy[key] ?? fallback;
}
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
/**
 * Ensure <root>/node_modules/@jackwener/opencli symlink exists so that
 * user CLIs in <root>/clis/ can `import { cli } from '@jackwener/opencli/registry'`.
 *
 * This is the sole resolution mechanism — adapters use package exports
 * (e.g. `@jackwener/opencli/registry`, `@jackwener/opencli/errors`) and
 * Node.js resolves them through this symlink.
 */
export async function ensureUserCliCompatShims(baseDir = USER_OPENCLI_DIR) {
    await fs.promises.mkdir(baseDir, { recursive: true });
    // package.json for ESM resolution in <root>/
    const pkgJsonPath = path.join(baseDir, 'package.json');
    const pkgJsonContent = `${JSON.stringify({ name: 'opencli-user-runtime', private: true, type: 'module' }, null, 2)}\n`;
    try {
        const existing = await fs.promises.readFile(pkgJsonPath, 'utf-8');
        if (existing !== pkgJsonContent)
            await fs.promises.writeFile(pkgJsonPath, pkgJsonContent, 'utf-8');
    }
    catch {
        await fs.promises.writeFile(pkgJsonPath, pkgJsonContent, 'utf-8');
    }
    // Create node_modules/@jackwener/opencli symlink pointing to the installed package root.
    //
    // Pin to dist/opencli-engine whenever it exists (published trees ship
    // dist only; dev trees have it after `bun run build`). Both runtimes
    // load the compiled JS fine, so bun and node daemons never fight over
    // the single symlink: without this pin, a later-started daemon of the
    // other runtime re-points the shim at its own tree (src for bun), and a
    // cached node daemon then loads TS sources through it — node's ESM
    // resolution (no extension probing) dies on the first extensionless
    // relative import. A source tree without dist/ falls back to PACKAGE_ROOT.
    const distEngineRoot = path.join(PACKAGE_ROOT, '..', '..', 'dist', 'opencli-engine');
    const opencliRoot = fs.existsSync(distEngineRoot) ? distEngineRoot : PACKAGE_ROOT;
    const symlinkDir = path.join(baseDir, 'node_modules', '@jackwener');
    const symlinkPath = path.join(symlinkDir, 'opencli');
    try {
        let needsUpdate = true;
        try {
            const existing = await fs.promises.readlink(symlinkPath);
            if (existing === opencliRoot)
                needsUpdate = false;
        }
        catch { /* doesn't exist */ }
        if (needsUpdate) {
            await fs.promises.mkdir(symlinkDir, { recursive: true });
            try {
                await fs.promises.rm(symlinkPath, { recursive: true, force: true });
            }
            catch { /* doesn't exist */ }
            const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
            await fs.promises.symlink(opencliRoot, symlinkPath, symlinkType);
        }
    }
    catch (err) {
        log.warn(`Could not create symlink at ${symlinkPath}: ${getErrorMessage(err)}`);
    }
    // Self-heal the in-repo node_modules link too (postinstall creates it,
    // but installs made before the dist-first fix keep pointing at src —
    // which is unrunnable under node). Same dist-first rule, idempotent.
    try {
        const repoRoot = path.join(PACKAGE_ROOT, '..', '..');
        const repoLink = path.join(repoRoot, 'node_modules', '@jackwener', 'opencli');
        const existing = await fs.promises.readlink(repoLink).catch(() => undefined);
        if (existing !== undefined && existing !== distEngineRoot && fs.existsSync(distEngineRoot)) {
            await fs.promises.rm(repoLink, { recursive: true, force: true });
            const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
            await fs.promises.symlink(distEngineRoot, repoLink, symlinkType);
        }
    }
    catch { /* best-effort self-heal; postinstall remains the primary fix */ }
}
/**
 * Best-effort one-time migration of user adapters from the legacy
 * `~/.opencli/clis/<site>/` layout to the new `<root>/clis/<site>/` layout.
 * A site is copied only when the destination does not exist yet (existing
 * destination wins; legacy files are kept, never deleted). Failures are
 * logged and never block startup.
 */
export async function migrateLegacyUserClis(legacyDir = LEGACY_USER_CLIS_DIR, destDir = USER_CLIS_DIR) {
    try {
        let entries;
        try {
            entries = await fs.promises.readdir(legacyDir, { withFileTypes: true });
        }
        catch {
            return; // No legacy directory — nothing to migrate.
        }
        const siteDirs = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
        for (const entry of siteDirs) {
            const src = path.join(legacyDir, entry.name);
            const dest = path.join(destDir, entry.name);
            try {
                await fs.promises.access(dest);
                continue; // Destination already exists — never overwrite.
            }
            catch { /* not present — copy */ }
            try {
                await fs.promises.mkdir(destDir, { recursive: true });
                await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true });
                log.info(`Migrated user adapter site "${entry.name}" from ${legacyDir} to ${destDir}`);
            }
            catch (err) {
                log.warn(`Skipped migrating user adapter site "${entry.name}": ${getErrorMessage(err)}`);
            }
        }
    }
    catch (err) {
        log.warn(`Legacy user adapter migration skipped: ${getErrorMessage(err)}`);
    }
}
/**
 * Ensure the user adapters directory exists.
 *
 * With smart sync, <root>/clis/ only holds files that differ from the
 * package baseline (upstream-synced cache + autofix output + user overrides).
 * Built-in adapters are loaded directly from the installed package.
 */
export async function ensureUserAdapters(clisDir = USER_CLIS_DIR) {
    await fs.promises.mkdir(clisDir, { recursive: true });
}
/**
 * Change signature of a clis tree: every .js file's mtimeMs, sorted by path.
 * Used by the daemon (#11) to detect adapters written after its startup —
 * the registry is cached in memory, so without this check a daemon started
 * before an adapter file existed never learns about it.
 *
 * Deliberately cheap: user trees are small (tens of files), and this runs
 * before every forwarded /command. Deletions and edits both shift the
 * signature; a re-discovery re-registers cleanly (registerCommand is
 * Map.set-overwrite semantics, aliases included).
 */
export async function clisTreeSignature(clisDir) {
    try {
        const entries = [];
        const walk = async (dir) => {
            let names;
            try {
                names = await fs.promises.readdir(dir);
            }
            catch {
                return;
            }
            for (const name of names) {
                const full = path.join(dir, name);
                let st;
                try {
                    st = await fs.promises.stat(full);
                }
                catch {
                    continue;
                }
                if (st.isDirectory()) {
                    await walk(full);
                }
                else if (name.endsWith('.js')) {
                    entries.push(`${full}:${st.mtimeMs}`);
                }
            }
        };
        await walk(clisDir);
        return entries.sort().join('|');
    }
    catch {
        return '';
    }
}
/**
 * #35: ESM caches modules by URL, so a re-discovery that imports a changed
 * adapter from its ORIGINAL path gets the old module namespace back — the
 * mtime-signature refresh (#11) only ever worked for new files (new URL =
 * fresh module); edits to existing files were a silent no-op. Query-busting
 * the entry cannot fix this (the entry's './lib' imports resolve back to
 * clean URLs, so the dependency chain stays cached), and neither runtime
 * exposes a module-cache invalidation API (checked: bun 1.3.x has none).
 * The portable fix is URL identity itself: copy the tree to a fresh
 * generation path and import from there — every module in the graph,
 * entry and libs alike, re-evaluates.
 *
 * The mirror lives under <root>/ so bare-specifier imports
 * ('@jackwener/opencli/registry') still resolve through the
 * <root>/node_modules shim to the SHARED engine instance — registry
 * identity is what makes re-registration (Map.set overwrite) actually
 * swap the handlers.
 *
 * Reload semantics: any change in the tree re-evaluates ALL user adapters
 * (module-level state resets — adapters must treat their state as
 * disposable). One live generation is kept: only the daemon imports from
 * the mirror (a second daemon cannot bind the port), so older generations
 * are garbage and get pruned on rebuild. Returns null when the source dir
 * is absent or the copy fails, so the caller can fall back to the legacy
 * behavior (new files only).
 */
let mirrorGeneration = 0;
export async function buildFreshCliMirror(clisDir = USER_CLIS_DIR, mirrorRoot = path.join(hubUserRoot(), '.adapter-reload')) {
    try {
        await fs.promises.access(clisDir);
    }
    catch {
        return null;
    }
    mirrorGeneration += 1;
    const genDir = path.join(mirrorRoot, `${Date.now().toString(36)}-${mirrorGeneration.toString(36)}`);
    try {
        await fs.promises.rm(mirrorRoot, { recursive: true, force: true });
        await fs.promises.mkdir(genDir, { recursive: true });
        const entries = await fs.promises.readdir(clisDir, { withFileTypes: true });
        await Promise.all(entries
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map(async (entry) => {
            await fs.promises.cp(path.join(clisDir, entry.name), path.join(genDir, entry.name), { recursive: true, dereference: true, force: true });
        }));
        return genDir;
    }
    catch (err) {
        log.warn(`Adapter reload mirror failed: ${getErrorMessage(err)}`);
        try {
            await fs.promises.rm(genDir, { recursive: true, force: true });
        }
        catch { /* best-effort */ }
        return null;
    }
}
/**
 * #35 follow-ups — one shared discovery/refresh unit for the two long-lived
 * faces (daemon, MCP server), so they can't drift apart again:
 *  - the MCP face previously discovered once per process with no refresh at
 *    all: an adapter written or edited while the server ran was invisible;
 *  - plugins were startup-scoped in both faces (#11 only covered clis);
 *  - a mirror reload re-evaluates modules, which register NEW hook function
 *    objects (addHook dedupes by identity) — without restoring the
 *    post-builtin hook snapshot, stale-generation handlers accumulate.
 *
 * Reload unit semantics: a change in EITHER tree reloads BOTH trees. A
 * partial reload would restore the hook snapshot while leaving the unchanged
 * tree's modules un-re-imported — its handlers would be wiped with nothing
 * left to re-register them. Absent trees are vacuously "mirrored" (nothing
 * to reload), so an empty plugins dir never trips the degradation path.
 *
 * The factory takes explicit dirs so tests can point it at temp trees; the
 * daemon and MCP server construct theirs with the real user dirs.
 */
export function createUserSourceReloader(builtinClisDir, opts = {}) {
    const clisDir = opts.clisDir ?? USER_CLIS_DIR;
    const pluginsDir = opts.pluginsDir ?? PLUGINS_DIR;
    const clisMirrorRoot = path.join(path.dirname(clisDir), '.adapter-reload');
    const pluginsMirrorRoot = path.join(path.dirname(pluginsDir), '.plugin-reload');
    let discovered = false;
    let lastClisSig = null;
    let lastPluginsSig = null;
    let baseHooksSnapshot = null;
    let refreshInFlight = null;
    async function discoverAll() {
        await Promise.all([
            ensureUserCliCompatShims(path.dirname(clisDir)),
            ensureUserAdapters(clisDir),
            discoverClis(builtinClisDir),
        ]);
        // Reload boundary: everything discovered so far never re-evaluates,
        // so its hooks are the restore point for every refresh below.
        baseHooksSnapshot = snapshotHooks();
        await discoverClis(clisDir);
        await discoverPlugins(pluginsDir);
        lastClisSig = await clisTreeSignature(clisDir);
        lastPluginsSig = await clisTreeSignature(pluginsDir);
        discovered = true;
    }
    async function mirrorOrDirect(dir, mirrorRoot) {
        const exists = await fs.promises.access(dir).then(() => true, () => false);
        if (!exists)
            return { target: dir, mirrored: true };
        const mirror = await buildFreshCliMirror(dir, mirrorRoot);
        return { target: mirror ?? dir, mirrored: mirror !== null };
    }
    async function doRefresh() {
        if (!discovered)
            return { changed: false };
        const clisSig = await clisTreeSignature(clisDir);
        const pluginsSig = await clisTreeSignature(pluginsDir);
        const clisChanged = clisSig !== lastClisSig;
        const pluginsChanged = pluginsSig !== lastPluginsSig;
        if (!clisChanged && !pluginsChanged)
            return { changed: false };
        if (baseHooksSnapshot)
            restoreHooks(baseHooksSnapshot);
        const clis = await mirrorOrDirect(clisDir, clisMirrorRoot);
        await discoverClis(clis.target);
        const plugins = await mirrorOrDirect(pluginsDir, pluginsMirrorRoot);
        await discoverPlugins(plugins.target);
        lastClisSig = clisSig;
        lastPluginsSig = pluginsSig;
        return {
            changed: true,
            clisChanged,
            pluginsChanged,
            mirrorDegraded: !(clis.mirrored && plugins.mirrored),
        };
    }
    /** Serialized: concurrent callers (e.g. parallel MCP tool calls) share one refresh — two racing rebuilds would clobber the mirror generation dir. */
    function refreshIfChanged() {
        refreshInFlight ??= doRefresh().finally(() => {
            refreshInFlight = null;
        });
        return refreshInFlight;
    }
    return { discoverAll, refreshIfChanged };
}
/**
 * Discover and register CLI commands.
 * Uses pre-compiled manifest when available for instant startup.
 */
export async function discoverClis(...dirs) {
    // Fast path: try manifest first (production / post-build)
    for (const dir of dirs) {
        const manifestPath = getCliManifestPath(dir);
        try {
            await fs.promises.access(manifestPath);
            const loaded = await loadFromManifest(manifestPath, dir);
            if (loaded)
                continue; // Skip filesystem scan only when manifest is usable
        }
        catch {
            // Fall through to filesystem scan
        }
        await discoverClisFromFs(dir);
    }
}
/**
 * Fast-path: register commands from pre-compiled manifest.
 * TS modules are deferred — loaded lazily on first execution.
 */
async function loadFromManifest(manifestPath, clisDir) {
    try {
        const raw = await fs.promises.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw);
        for (const entry of manifest) {
            if (!entry.modulePath)
                continue;
            const modulePath = path.resolve(clisDir, entry.modulePath);
            const cmd = {
                site: entry.site,
                name: entry.name,
                aliases: entry.aliases,
                description: entry.description ?? '',
                access: entry.access,
                example: entry.example,
                domain: entry.domain,
                strategy: parseStrategy(entry.strategy),
                browser: entry.browser,
                args: entry.args ?? [],
                columns: entry.columns,
                defaultFormat: entry.defaultFormat,
                pipeline: entry.pipeline,
                source: entry.sourceFile ? path.resolve(clisDir, entry.sourceFile) : modulePath,
                navigateBefore: entry.navigateBefore,
                siteSession: entry.siteSession,
                defaultWindowMode: entry.defaultWindowMode,
                _lazy: true,
                _modulePath: modulePath,
            };
            // normalizeCommand inside registerCommand handles strategy → browser/navigateBefore
            registerCommand(cmd);
        }
        return true;
    }
    catch (err) {
        log.warn(`Failed to load manifest ${manifestPath}: ${getErrorMessage(err)}`);
        return false;
    }
}
/**
 * Fallback: traditional filesystem scan (used during development with tsx).
 */
async function discoverClisFromFs(dir) {
    try {
        await fs.promises.access(dir);
    }
    catch {
        return;
    }
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const sitePromises = entries
        .filter(entry => entry.isDirectory())
        .map(async (entry) => {
        const site = entry.name;
        const siteDir = path.join(dir, site);
        const files = await fs.promises.readdir(siteDir);
        await Promise.all(files.map(async (file) => {
            const filePath = path.join(siteDir, file);
            if (file.endsWith('.yaml') || file.endsWith('.yml')) {
                return;
            }
            if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts')) {
                log.warn(`Ignoring TypeScript adapter ${filePath} — .ts adapters are no longer loaded. Rename to .js or convert to JavaScript.`);
                return;
            }
            if (file.endsWith('.js') && !file.endsWith('.d.js') && !file.endsWith('.test.js')) {
                if (!(await isCliModule(filePath)))
                    return;
                await import(pathToFileURL(filePath).href).catch((err) => {
                    log.warn(`Failed to load module ${filePath}: ${getErrorMessage(err)}`);
                });
            }
        }));
    });
    await Promise.all(sitePromises);
}
/**
 * Discover and register plugins from <root>/plugins/.
 * Each subdirectory is treated as a plugin (site = directory name).
 * Files inside are scanned flat (no nested site subdirs).
 */
export async function discoverPlugins(pluginsDir = PLUGINS_DIR) {
    try {
        await fs.promises.access(pluginsDir);
    }
    catch {
        return;
    }
    const entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
        const pluginDir = path.join(pluginsDir, entry.name);
        if (!(await isDiscoverablePluginDir(entry, pluginDir)))
            return;
        await discoverPluginDir(pluginDir, entry.name);
    }));
}
/**
 * Flat scan: read ts/js files directly in a plugin directory.
 * Unlike discoverClisFromFs, this does NOT expect nested site subdirectories.
 */
async function discoverPluginDir(dir, site) {
    const files = await fs.promises.readdir(dir);
    const fileSet = new Set(files);
    await Promise.all(files.map(async (file) => {
        const filePath = path.join(dir, file);
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            return;
        }
        if (file.endsWith('.js') && !file.endsWith('.d.js')) {
            if (!(await isCliModule(filePath)))
                return;
            await import(pathToFileURL(filePath).href).catch((err) => {
                log.warn(`Plugin ${site}/${file}: ${getErrorMessage(err)}`);
            });
        }
        else if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts')) {
            const jsFile = file.replace(/\.ts$/, '.js');
            // Prefer compiled .js — skip the .ts source file
            if (fileSet.has(jsFile))
                return;
            // No compiled .js found — cannot import raw .ts in production Node.js.
            // This typically means esbuild transpilation failed during plugin install.
            log.warn(`Plugin ${site}/${file}: no compiled .js found. ` +
                `Run "hub plugin update ${site}" to re-transpile, or install esbuild.`);
        }
    }));
}
async function isCliModule(filePath) {
    try {
        const source = await fs.promises.readFile(filePath, 'utf-8');
        return PLUGIN_MODULE_PATTERN.test(source);
    }
    catch (err) {
        log.warn(`Failed to inspect module ${filePath}: ${getErrorMessage(err)}`);
        return false;
    }
}
async function isDiscoverablePluginDir(entry, pluginDir) {
    if (entry.isDirectory())
        return true;
    if (!entry.isSymbolicLink())
        return false;
    try {
        return (await fs.promises.stat(pluginDir)).isDirectory();
    }
    catch (err) {
        const code = err.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            log.warn(`Failed to inspect plugin link ${pluginDir}: ${getErrorMessage(err)}`);
        }
        return false;
    }
}
