import { preflight, assets, branch, prepareRelease, diffSanity, review, tagCheckout } from "./steps/prepare.mjs";
import { archBuild, archSmoke, flatpakBuild, flatpakLint, flatpakConflict, flatpakSmoke, docker, appImageBuild, appImageSmoke } from "./steps/linux.mjs";
import { windowsStart, windowsBuild, windowsSmoke, windowsInstaller, windowsInstalled, windowsStop } from "./steps/windows.mjs";
import { macWake, macResidue, macBuild, macSmoke, macSleep } from "./steps/mac.mjs";
import {
    pushBranch,
    deployPullRequest,
    deployMerge,
    updateMain,
    createFlatpakTag,
    pushFlatpakTag,
    aurCommit,
    aurPush,
    flathubBranch,
    flathubPush,
    flathubPullRequest,
    submoduleCommit,
    flathubReinstall,
} from "./steps/publish.mjs";

const testSteps = [
    macWake,
    macResidue,
    macBuild,
    archBuild,
    archSmoke,
    macSmoke,
    macSleep,
    flatpakBuild,
    flatpakLint,
    flatpakConflict,
    flatpakSmoke,
    docker,
    appImageBuild,
    appImageSmoke,
    windowsStart,
    windowsBuild,
    windowsSmoke,
    windowsInstaller,
    windowsInstalled,
    windowsStop,
];

/**
 * Every step in display order; "run all" also starts them in this order when they are ready.
 */
const buildPipeline = () => [
    preflight,
    assets,
    branch,
    prepareRelease,
    diffSanity,
    review,
    tagCheckout,
    ...testSteps,
    pushBranch(testSteps.map((step) => step.id)),
    deployPullRequest,
    deployMerge,
    updateMain,
    createFlatpakTag,
    pushFlatpakTag,
    aurCommit,
    aurPush,
    flathubBranch,
    flathubPush,
    flathubPullRequest,
    submoduleCommit,
    flathubReinstall,
];

export { buildPipeline };
