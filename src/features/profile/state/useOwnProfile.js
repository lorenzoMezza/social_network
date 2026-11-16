// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback } from 'react';
import { useMe } from '../../me/MeProvider';
import { BIO_MAX_LENGTH, NAME_MAX_LENGTH, cleanUsername, usernameProblem } from '../model/names';

// The signed-in user's profile (MeProvider: the backend's GET /me), with what the
// profile screen changes: names, bio, picture. Saved on the server; a taken @handle
// comes back as an error the screen shows.
export function useOwnProfile() {
  const { me, id, update, setPicture } = useMe();

  const setBio = useCallback((value) => update({ bio: value.trim().slice(0, BIO_MAX_LENGTH) }), [update]);

  // Both at once, from the profile's editor; the username is unique on the server
  const setNames = useCallback(async ({ name, username }) => {
    const nextName = name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX_LENGTH);
    const nextUsername = cleanUsername(username);
    if (!nextName) throw new Error('A name is needed');
    if (usernameProblem(nextUsername)) throw new Error(usernameProblem(nextUsername));
    try {
      await update({ name: nextName, username: nextUsername });
    } catch (error) {
      if (error?.code === 'username_taken') throw new Error(`@${nextUsername} is taken, try another one`);
      throw error;
    }
  }, [update]);

  return {
    id,
    name: me?.name ?? '',
    username: me?.username ?? null,
    picture: me?.pictureUrl ?? null,
    hasOwnPicture: !!me?.pictureUrl,
    setPicture,
    bio: me?.bio ?? '',
    setBio,
    setNames,
    loaded: !!me,
  };
}
