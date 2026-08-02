import * as fs from 'node:fs';
import * as path from 'node:path';
export function findPackageRoot(startFile, fileExists = fs.existsSync) {
    let dir = path.dirname(startFile);
    while (true) {
        const pkgPath = path.join(dir, 'package.json');
        if (fileExists(pkgPath)) {
            // hub-browser: skip nested package.json (e.g. src/opencli-engine/package.json)
            // Continue up to the project root marked with "hubBrowserRoot": true
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.hubBrowserRoot) return dir;
            } catch { /* not a valid json, return this dir */ return dir; }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`Could not find package.json above ${startFile}`);
        }
        dir = parent;
    }
}
export function getBuiltEntryCandidates(packageRoot, readFile = (filePath) => fs.readFileSync(filePath, 'utf-8')) {
    const candidates = [];
    try {
        const pkg = JSON.parse(readFile(path.join(packageRoot, 'package.json')));
        if (typeof pkg.bin === 'string') {
            candidates.push(path.join(packageRoot, pkg.bin));
        }
        else if (pkg.bin && typeof pkg.bin === 'object' && typeof pkg.bin.opencli === 'string') {
            candidates.push(path.join(packageRoot, pkg.bin.opencli));
        }
        if (typeof pkg.main === 'string') {
            candidates.push(path.join(packageRoot, pkg.main));
        }
    }
    catch {
        // Fall through to compatibility candidates below.
    }
    // Compatibility fallback for partially-built trees or older layouts.
    candidates.push(path.join(packageRoot, 'dist', 'src', 'main.js'), path.join(packageRoot, 'dist', 'main.js'));
    return [...new Set(candidates)];
}
export function getCliManifestPath(clisDir) {
    return path.resolve(clisDir, '..', 'cli-manifest.json');
}
export function getFetchAdaptersScriptPath(packageRoot) {
    return path.join(packageRoot, 'scripts', 'fetch-adapters.js');
}
