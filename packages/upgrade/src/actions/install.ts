import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { color, say } from '@astrojs/cli-kit';
import { random, sleep } from '@astrojs/cli-kit/utils';
import { resolveCommand } from 'package-manager-detector';
import {
	banner,
	bye,
	celebrations,
	changelog,
	done,
	error,
	info,
	newline,
	pluralize,
	spinner,
	success,
	title,
	upgrade,
	warn,
} from '../messages.js';
import { shell } from '../shell.js';
import type { Context, PackageInfo } from './context.js';

export async function install(
	ctx: Pick<
		Context,
		'version' | 'packages' | 'packageManager' | 'prompt' | 'dryRun' | 'exit' | 'cwd'
	>,
	shellFn: typeof shell = shell,
) {
	await banner();
	newline();
	const { current, dependencies, devDependencies } = filterPackages(ctx);
	const toInstall = [...dependencies, ...devDependencies].sort(sortPackages);
	for (const packageInfo of current.sort(sortPackages)) {
		const tag = /^\d/.test(packageInfo.targetVersion)
			? packageInfo.targetVersion
			: packageInfo.targetVersion.slice(1);
		await info(`${packageInfo.name}`, `is up to date on`, `v${tag}`);
		await sleep(random(50, 150));
	}
	if (toInstall.length === 0 && !ctx.dryRun) {
		newline();
		await success(random(celebrations), random(done));
		return;
	}
	const majors: PackageInfo[] = [];
	for (const packageInfo of toInstall) {
		const word = ctx.dryRun ? 'can' : 'will';
		await upgrade(packageInfo, `${word} be updated`);
		if (packageInfo.isMajor) {
			majors.push(packageInfo);
		}
	}
	if (majors.length > 0) {
		const { proceed } = await ctx.prompt({
			name: 'proceed',
			type: 'confirm',
			label: title('wait'),
			message: `${pluralize(
				['One package has', 'Some packages have'],
				majors.length,
			)} breaking changes. Continue?`,
			initial: true,
		});
		if (!proceed) {
			return ctx.exit(0);
		}

		newline();

		await warn('check', `Be sure to follow the ${pluralize('CHANGELOG', majors.length)}.`);
		for (const pkg of majors.sort(sortPackages)) {
			await changelog(pkg.name, pkg.changelogTitle!, pkg.changelogURL!);
		}
	}

	newline();
	if (ctx.dryRun) {
		await info('--dry-run', `Skipping dependency installation`);
	} else {
		await runInstallCommand(ctx, dependencies, devDependencies, shellFn);
	}
}

function filterPackages(ctx: Pick<Context, 'packages'>) {
	const current: PackageInfo[] = [];
	const dependencies: PackageInfo[] = [];
	const devDependencies: PackageInfo[] = [];
	for (const packageInfo of ctx.packages) {
		const { currentVersion, targetVersion, isDevDependency } = packageInfo;
		// Remove prefix from version before comparing
		if (currentVersion.replace(/^\D+/, '') === targetVersion.replace(/^\D+/, '')) {
			current.push(packageInfo);
		} else {
			const arr = isDevDependency ? devDependencies : dependencies;
			arr.push(packageInfo);
		}
	}
	return { current, dependencies, devDependencies };
}

/**
 * An `Array#sort` comparator function to normalize how packages are displayed.
 * This only changes how the packages are displayed in the CLI, it is not persisted to `package.json`.
 */
function sortPackages(a: PackageInfo, b: PackageInfo): number {
	if (a.isMajor && !b.isMajor) return 1;
	if (b.isMajor && !a.isMajor) return -1;
	if (a.name === 'astro') return -1;
	if (b.name === 'astro') return 1;
	if (a.name.startsWith('@astrojs') && !b.name.startsWith('@astrojs')) return -1;
	if (b.name.startsWith('@astrojs') && !a.name.startsWith('@astrojs')) return 1;
	return a.name.localeCompare(b.name);
}

async function runInstallCommand(
	ctx: Pick<Context, 'cwd' | 'packageManager' | 'exit'>,
	dependencies: PackageInfo[],
	devDependencies: PackageInfo[],
	shellFn: typeof shell = shell,
) {
	const cwd = fileURLToPath(ctx.cwd);
	if (ctx.packageManager.name === 'yarn') await ensureYarnLock({ cwd });

	const installCommand = resolveCommand(ctx.packageManager.agent, 'add', []);
	if (!installCommand) {
		// NOTE: Usually it's impossible to reach here as `package-manager-detector` should
		// already match a supported agent
		error('error', `Unable to find install command for ${ctx.packageManager.name}.`);
		return ctx.exit(1);
	}
	const doInstall = async (legacyPeerDeps = false) => {
		try {
			if (dependencies.length > 0) {
				await shellFn(
					installCommand.command,
					[
						...installCommand.args,
						...(legacyPeerDeps ? ['--legacy-peer-deps'] : []),
						...dependencies.map(
							({ name, targetVersion }) => `${name}@${targetVersion.replace(/^\^/, '')}`,
						),
					],
					{ cwd, timeout: 90_000 },
				);
			}
			if (devDependencies.length > 0) {
				await shellFn(
					installCommand.command,
					[
						...installCommand.args,
						...(legacyPeerDeps ? ['--legacy-peer-deps'] : []),
						...devDependencies.map(
							({ name, targetVersion }) => `${name}@${targetVersion.replace(/^\^/, '')}`,
						),
					],
					{ cwd, timeout: 90_000 },
				);
			}
		} catch (err: unknown) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			// If the error is related to peer dependencies, we can try again with `--legacy-peer-deps`
			if (
				ctx.packageManager.name === 'npm' &&
				!legacyPeerDeps &&
				errorMessage.includes('peer dependenc')
			) {
				return doInstall(true);
			}

			const manualInstallCommand = [
				installCommand.command,
				...installCommand.args,
				...[...dependencies, ...devDependencies].map(
					({ name, targetVersion }) => `${name}@${targetVersion}`,
				),
			].join(' ');
			newline();
			error(
				'error',
				`Dependencies failed to install, please run the following command manually:\n${color.bold(manualInstallCommand)}`,
			);
			return ctx.exit(1);
		}
	};

	await spinner({
		start: `Installing dependencies with ${ctx.packageManager.name}...`,
		end: `Installed dependencies!`,
		while: doInstall,
	});

	await say([`${random(celebrations)} ${random(done)}`, random(bye)], { clear: false });
}

/**
 * Yarn Berry (PnP) versions will throw an error if there isn't an existing `yarn.lock` file
 * If a `yarn.lock` file doesn't exist, this function writes an empty `yarn.lock` one.
 * Unfortunately this hack is required to run `yarn install`.
 *
 * The empty `yarn.lock` file is immediately overwritten by the installation process.
 * See https://github.com/withastro/astro/pull/8028
 */
async function ensureYarnLock({ cwd }: { cwd: string }) {
	const yarnLock = path.join(cwd, 'yarn.lock');
	if (fs.existsSync(yarnLock)) return;
	return fs.promises.writeFile(yarnLock, '', { encoding: 'utf-8' });
}
