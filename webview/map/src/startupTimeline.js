// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// When each step of the page's start happened (ms from the moment the page began to load):
// the developer overlay shows them, and a phone's real numbers say what to look at. A few
// timestamps kept in an array: nothing else runs for this.
const marks = [];

export function startupMark(name) {
  if (!marks.some((mark) => mark.name === name)) marks.push({ name, at: performance.now() });
}

export const startupMarks = () => marks;

startupMark('script');
