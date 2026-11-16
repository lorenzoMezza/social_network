// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { ActionSheet } from '../../components/ui/ActionSheet';
import { useTabLinks } from '../../components/navigation/useTabLinks';
import { BioField } from './components/BioField';
import { NamesField } from './components/NamesField';
import { BellButton, HeroButton, ProfileView } from './components/ProfileView';
import { useOwnProfile } from './state/useOwnProfile';
import { BIO_MAX_LENGTH } from './model/names';
import { stageOf, useOwnProfileStyle } from './state/profileStyle';
import { useActivity } from './state/profileData';
import { useMe } from '../me/MeProvider';
import { useApi } from '../api/useApi';
import { useNotifications } from '../notifications/state/NotificationsProvider';
import { failureMessage } from '../api/failureMessage';
import { discardPickedFile } from '../api/uploads';

// A square photo, cropped by the system's editor (like every social app)
const PICK_OPTIONS = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 0.85,
  // iOS hands over a JPEG, never the HEIC original
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

// The user's own profile: their avatar in the world they chose (Style), their photo,
// name, username and bio changed right here, their numbers and their story
export function ProfileScreen() {
  const { unread } = useNotifications();
  const profile = useOwnProfile();
  const { me, refresh, captureSession } = useMe();
  const [style] = useOwnProfileStyle();
  // The story: events organized, joined, reviewed, connections made (the server's)
  const { sections: timeline, loading: timelineLoading, reload: reloadStory } = useActivity(profile.id, profile.id);
  const request = useApi();

  // A moment of the story, long-pressed: shown to others, or not (only the user sees it)
  const chooseMoment = useCallback((entry) => {
    // The story again, and the profile (how many moments are hidden: the Edit sheet)
    const change = () => request(`/me/story/hidden/${encodeURIComponent(entry.key)}`, { method: entry.hidden ? 'DELETE' : 'PUT' })
      .then(() => Promise.all([reloadStory(), refresh()]))
      .catch((error) => Alert.alert('Could not change it', failureMessage(error)));
    Alert.alert(
      entry.hidden ? 'Show this on your story?' : 'Hide this from your story?',
      entry.hidden ? 'People who open your profile will see it again.' : 'Only you will see it. It stays here, faded.',
      [{ text: 'Cancel', style: 'cancel' }, { text: entry.hidden ? 'Show' : 'Hide', onPress: change }],
    );
  }, [request, reloadStory, refresh]);
  // The numbers change elsewhere (an event organized, a connection made)
  useFocusEffect(useCallback(() => {
    refresh();
  }, [refresh]));
  const links = useTabLinks();
  const [photoSheet, setPhotoSheet] = useState(false);

  const applyPicked = async (result, session) => {
    if (captureSession() !== session || result.canceled || !result.assets?.[0]) return;
    try {
      await profile.setPicture(result.assets[0].uri, session);
    } catch {
      // Not used: the copy the picker made does not stay on the phone
      discardPickedFile(result.assets[0].uri);
      Alert.alert('Could not use this photo', 'Try another one.');
    }
  };

  const fromLibrary = async () => {
    const session = captureSession();
    try {
      await applyPicked(await ImagePicker.launchImageLibraryAsync(PICK_OPTIONS), session);
    } catch {
      Alert.alert('Could not open your photos');
    }
  };

  const fromCamera = async () => {
    const session = captureSession();
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (captureSession() !== session) return;
      if (!permission.granted) {
        Alert.alert('Camera not allowed', 'Allow the camera in Settings to take a photo.');
        return;
      }
      await applyPicked(await ImagePicker.launchCameraAsync(PICK_OPTIONS), session);
    } catch {
      Alert.alert('No camera available');
    }
  };

  const photoItems = [
    { label: 'Choose from library', icon: 'images-outline', onPress: fromLibrary },
    { label: 'Take photo', icon: 'camera-outline', onPress: fromCamera },
    ...(profile.hasOwnPicture ? [{
      label: 'Remove photo',
      icon: 'trash-outline',
      destructive: true,
      onPress: () => profile.setPicture(null).catch((error) => Alert.alert('Could not remove the photo', failureMessage(error))),
    }] : []),
  ];

  return (
    <ProfileView
      isOwn
      userId={profile.id}
      name={profile.name}
      username={profile.username}
      picture={profile.picture}
      onPhotoPress={() => setPhotoSheet(true)}
      stage={stageOf(style)}
      stats={[
        { label: 'Events', value: me?.stats?.organized ?? null, onPress: profile.id ? () => router.push(links.organized(profile.id)) : undefined },
        { label: 'Connections', value: me?.stats?.connections ?? null, onPress: () => router.push('/profile/connections') },
        // The score is not defined yet
        { label: 'Score', text: 'Soon', muted: true },
      ]}
      timeline={timeline}
      timelineLoading={timelineLoading}
      storyAction={{ label: 'Edit', onPress: () => router.push('/story-settings') }}
      onEntryLongPress={chooseMoment}
      // The notifications: only what matters (people joining, changes, requests)
      topRight={<BellButton count={unread} onPress={() => router.push('/notifications')} />}
      heroActions={(
        <>
          <HeroButton icon="shirt-outline" label="Edit avatar" onPress={() => router.push('/avatar-editor')} />
          <HeroButton icon="color-palette-outline" label="Style" onPress={() => router.push('/profile-style')} />
        </>
      )}
      names={<NamesField name={profile.name} username={profile.username} editable onSave={profile.setNames} />}
      bio={<BioField bio={profile.bio} editable maxLength={BIO_MAX_LENGTH} onSave={profile.setBio} />}
      emptyTimeline={{ title: 'Your story starts here', message: 'The events you organize, join and review will show up here, newest first.' }}
    >
      <ActionSheet visible={photoSheet} onClose={() => setPhotoSheet(false)} title="Profile photo" items={photoItems} />
    </ProfileView>
  );
}
