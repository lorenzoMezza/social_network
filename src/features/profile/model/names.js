// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The limits of docs/API.md (Me): the bio, the name shown (not unique) and the
// unique @handle, with the rules the server checks too (what links and mentions read
// well, like other social apps)
export const BIO_MAX_LENGTH = 200;
export const NAME_MAX_LENGTH = 30;
const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

// What can be typed in a username: lowercase letters, digits, dots and underscores
export const cleanUsername = (value) => value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._]/g, '').slice(0, USERNAME_MAX_LENGTH);

// Why a username can't be used, or null
export function usernameProblem(value) {
  if (value.length < USERNAME_MIN_LENGTH) return `At least ${USERNAME_MIN_LENGTH} characters`;
  if (/^\.|\.$/.test(value)) return 'It can\'t start or end with a dot';
  if (value.includes('..')) return 'No two dots in a row';
  return null;
}
