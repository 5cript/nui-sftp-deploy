const splitLines = (str) => str.split(/\r?\n/);
const onLineMatchingModify = (lines, regex, modifyFn) => {
  const modifiedLines = [];

  for (const line of lines) {
    const match = regex.exec(line);

    if (match) {
      modifiedLines.push(modifyFn(line, match));
    } else {
      modifiedLines.push(line);
    }
  }

  return modifiedLines;
};
const findLineIndexMatching = (lines, regex) => {
  let match = null;
    for (let i = 0; i < lines.length; i++) {
        const match = regex.exec(lines[i]);
        if (match) {
            return { lineIndex: i, match };
        }
    }
    return { lineIndex: -1, match: null };
}

export { splitLines, onLineMatchingModify, findLineIndexMatching };