// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Alert } from 'react-native';
import { router } from 'expo-router';
import { ActionSheet } from '../../components/ui/ActionSheet';
import { useTabLinks } from '../../components/navigation/useTabLinks';
import { useSocial } from '../social/state/SocialProvider';
import { usePersonActions } from '../social/components/usePersonActions';
import { useMe } from '../me/MeProvider';
import { HeroButton, ProfileView } from './components/ProfileView';
import { BioField } from './components/BioField';
import { stageOf } from './state/profileStyle';
import { useActivity, useProfile } from './state/profileData';

// Someone else's profile (an organizer, a connection, someone on the map), laid out
// like the user's own, from the server (GET /users/{id}): their world, picture, name,
// bio, numbers, their story, and what can be done about them (⋯: disconnect, block,
// report). `name` and `username` (from the link) show while it loads.
export function UserProfileScreen({ id, name, username }) {
  const { id: myId } = useMe();
  const { canMessage, isBlocked, openDirect } = useSocial();
  const { profile, error } = useProfile(id);
  const { sections: timeline, loading: timelineLoading } = useActivity(id, myId);
  const links = useTabLinks();
  const person = profile ?? { id, name, username };
  const shown = person.name || person.username || 'Someone';
  const actions = usePersonActions(person.username ? person : null);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const blocked = profile?.relation?.blocked ?? isBlocked(id);
  const writable = profile?.relation?.canMessage ?? canMessage(id);
  // Their story and lists are for their connections (the server sends none of them)
  const open = profile?.relation?.seesStory !== false;

  const message = () => openDirect(id)
    .then((chatId) => router.push({ pathname: '/chat/[id]', params: { id: chatId } }))
    .catch(() => Alert.alert('You can\'t write to them right now', 'Connect in person, or meet them nearby.'));

  return (
    <ProfileView
      isOwn={false}
      userId={id}
      name={error?.status === 404 ? 'Not available' : shown}
      username={person.username}
      picture={profile?.pictureUrl ?? null}
      stage={stageOf(profile?.style)}
      bio={profile?.bio ? <BioField bio={profile.bio} /> : null}
      stats={[
        { label: 'Events', value: profile?.stats?.organized ?? null, onPress: open ? () => router.push(links.organized(id, { name: shown })) : undefined },
        // Their connections, like on one's own profile: the ones in common first
        blocked
          ? { label: 'Connections', value: null, text: 'Blocked' }
          : { label: 'Connections', value: profile?.stats?.connections ?? null, onPress: open ? () => router.push(links.people(id, { name: shown })) : undefined },
        { label: 'Score', text: 'Soon', muted: true },
      ]}
      timeline={timeline}
      timelineLoading={timelineLoading}
      topLeft={<HeroButton icon="chevron-back" accessibilityLabel="Back" onPress={back} />}
      topRight={person.username ? <HeroButton icon="ellipsis-horizontal" accessibilityLabel={`More about ${shown}`} onPress={actions.open} /> : null}
      heroActions={writable && !blocked ? <HeroButton icon="chatbubble-outline" label="Message" onPress={message} /> : null}
      emptyTimeline={open
        ? { title: 'Nothing here yet', message: `${shown} has not organized or joined anything yet.` }
        : { title: 'Only for their connections', message: `Connect with ${shown} in person to see their story.` }}
    >
      <ActionSheet {...actions.sheet} />
    </ProfileView>
  );
}
