import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules, createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { napcatHmrPlugin } from 'napcat-plugin-debug-cli/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

const nodeModules = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
].flat();

// 原生引擎依赖 SDK 的相对路径布局，不能合并进 index.mjs。
const external = ['@pixel.js/shotium'];

function copyShotiumPlugin() {
    return {
        name: 'copy-shotium',
        writeBundle() {
            const require = createRequire(import.meta.url);
            const manifestPath = require.resolve('@pixel.js/shotium/package.json');
            const sdkDir = dirname(manifestPath);
            const sdk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const sdkRequire = createRequire(manifestPath);
            const modulesDir = resolve(__dirname, 'dist/node_modules');
            const sdkDest = resolve(modulesDir, '@pixel.js/shotium');
            fs.mkdirSync(sdkDest, { recursive: true });
            fs.copyFileSync(manifestPath, resolve(sdkDest, 'package.json'));
            fs.cpSync(resolve(sdkDir, 'dist'), resolve(sdkDest, 'dist'), { recursive: true });

            let copied = 0;
            const missing: string[] = [];
            for (const name of Object.keys(sdk.optionalDependencies || {})) {
                let nativeManifestPath: string;
                try {
                    nativeManifestPath = sdkRequire.resolve(`${name}/package.json`);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
                    missing.push(name);
                    continue;
                }
                const nativeDir = dirname(nativeManifestPath);
                const nativePkg = JSON.parse(fs.readFileSync(nativeManifestPath, 'utf8'));
                if (nativePkg.version !== sdk.version) {
                    throw new Error(`Shotium 版本不匹配: ${name}@${nativePkg.version}, SDK@${sdk.version}`);
                }
                for (const file of ['shotium.node', 'shotium_data.pak', 'shotium_strings.pak']) {
                    if (!fs.existsSync(resolve(nativeDir, file))) {
                        throw new Error(`Shotium 原生包缺少文件: ${name}/${file}`);
                    }
                }
                fs.cpSync(nativeDir, resolve(modulesDir, name), { recursive: true, dereference: true });
                copied++;
            }
            if (copied === 0 || (process.env.SHOTIUM_ALL_PLATFORMS === '1' && missing.length > 0)) {
                throw new Error(`Shotium 原生依赖不完整，请使用 pnpm 9 安装依赖。缺少: ${missing.join(', ')}`);
            }
            console.log(`[copy-shotium] 已复制 SDK 和 ${copied} 个平台的原生引擎`);
        },
    };
}

/**
 * 递归复制目录
 */
function copyDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = resolve(src, entry.name);
        const destPath = resolve(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * 构建后自动复制资源的 Vite 插件
 * - 生成精简的 package.json（只保留运行时必要字段）
 * - 复制 templates 目录（如果存在）
 */
function copyAssetsPlugin() {
    return {
        name: 'copy-assets',
        writeBundle() {
            try {
                const distDir = resolve(__dirname, 'dist');

                // 生成精简的 package.json（只保留运行时必要字段）
                const pkgPath = resolve(__dirname, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                    const distPkg: Record<string, unknown> = {
                        name: pkg.name,
                        plugin: pkg.plugin,
                        version: pkg.version,
                        type: pkg.type,
                        main: pkg.main,
                        icon: pkg.icon,
                        description: pkg.description,
                        author: pkg.author,
                        dependencies: Object.fromEntries(external.map(name => [name, pkg.dependencies[name]])),
                    };
                    if (pkg.napcat) {
                        distPkg.napcat = pkg.napcat;
                    }
                    fs.writeFileSync(
                        resolve(distDir, 'package.json'),
                        JSON.stringify(distPkg, null, 2)
                    );
                    console.log('[copy-assets] (o\'v\'o) 已生成精简 package.json');
                }

                // 复制 templates 目录（如果存在）
                const templatesSrc = resolve(__dirname, 'templates');
                if (fs.existsSync(templatesSrc)) {
                    copyDirRecursive(templatesSrc, resolve(distDir, 'templates'));
                    console.log('[copy-assets] (o\'v\'o) 已复制 templates 目录');
                }

                // 复制 webui 目录（如果存在）
                const webuiSrc = resolve(__dirname, 'src/webui');
                if (fs.existsSync(webuiSrc)) {
                    copyDirRecursive(webuiSrc, resolve(distDir, 'webui'));
                    console.log('[copy-assets] (o\'v\'o) 已复制 webui 目录');
                }

                // 复制插件图标（如果存在）
                const iconSrc = resolve(__dirname, 'icon.png');
                if (fs.existsSync(iconSrc)) {
                    fs.copyFileSync(iconSrc, resolve(distDir, 'icon.png'));
                    console.log('[copy-assets] (o\'v\'o) 已复制插件图标 icon.png');
                }

                // 复制 resources 目录
                const resourcesSrc = resolve(__dirname, 'src/resources');
                if (fs.existsSync(resourcesSrc)) {
                    copyDirRecursive(resourcesSrc, resolve(distDir, 'resources'));
                    console.log('[copy-assets] (o\'v\'o) 已复制 resources 目录');
                }

                console.log('[copy-assets] (*\'v\'*) 资源复制完成！');
            } catch (error) {
                console.error('[copy-assets] (;_;) 资源复制失败:', error);
            }
        },
    };
}

export default defineConfig({
    define: {
        '__PLUGIN_VERSION__': JSON.stringify(pkg.version),
    },
    resolve: {
        conditions: ['node', 'default'],
    },
    build: {
        sourcemap: false,
        target: 'esnext',
        minify: false,
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: () => 'index.mjs',
        },
        rollupOptions: {
            external: [...nodeModules, ...external],
            output: {
                inlineDynamicImports: true,
            },
        },
        outDir: 'dist',
    },
    plugins: [nodeResolve(), copyAssetsPlugin(), copyShotiumPlugin(), napcatHmrPlugin()],
});
