import { existsSync } from "node:fs";

const candidates = [
    ["ocean-alarm-clock", "Ocean: alarm clock", "/usr/share/sounds/ocean/stereo/alarm-clock-elapsed.oga"],
    ["ocean-completion", "Ocean: completion", "/usr/share/sounds/ocean/stereo/completion-success.oga"],
    ["ocean-outcome", "Ocean: success", "/usr/share/sounds/ocean/stereo/outcome-success.oga"],
    ["ocean-bell", "Ocean: bell", "/usr/share/sounds/ocean/stereo/bell.oga"],
    ["ocean-message", "Ocean: message", "/usr/share/sounds/ocean/stereo/message-new-instant.oga"],
    ["ocean-highlight", "Ocean: highlight", "/usr/share/sounds/ocean/stereo/message-highlight.oga"],
    ["ocean-winner", "Ocean: winner", "/usr/share/sounds/ocean/stereo/game-over-winner.oga"],
    ["freedesktop-complete", "freedesktop: complete", "/usr/share/sounds/freedesktop/stereo/complete.oga"],
    ["freedesktop-bell", "freedesktop: bell", "/usr/share/sounds/freedesktop/stereo/bell.oga"],
    ["freedesktop-alarm-clock", "freedesktop: alarm clock", "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga"],
];

/**
 * Alarm sounds: the built-in chime (synthesized in the page) and the system sound theme files that exist here. The
 * files are only played locally, never copied.
 */
const availableSounds = () => [
    { id: "chime", label: "Chime (built in)" },
    ...candidates.filter(([, , path]) => existsSync(path)).map(([id, label, path]) => ({ id, label, path })),
];

export { availableSounds };
