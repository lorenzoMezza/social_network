// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { MapWebView } from './components/MapWebView';
import { MapStatusIndicators } from './components/MapStatusIndicators';
import { VisibilitySwitch } from './components/VisibilitySwitch';
import { EventMapCard } from './components/EventMapCard';
import { PersonMapCard } from './components/PersonMapCard';
import { BroadcastMapCard } from './components/BroadcastMapCard';
import { MapToast } from './components/MapToast';
import { useMapEvents } from './hooks/useMapEvents';
import { useMapPeople } from './hooks/useMapPeople';
import { useMapBubbles } from './hooks/useMapBubbles';
import { useMapWeather } from './hooks/useMapWeather';
import { useIncomingBroadcasts, useIncomingGestures, usePresenceSync, useSendBroadcast, useSendGesture } from './state/nearbyPeople';
import { gestureInfo } from './model/gestures';
import { BROADCAST_COOLDOWN_MS } from './model/broadcasts';
import { useMapMode } from './state/mapVisibility';
import { useMapAudience } from './state/mapPresence';
import { createSharingWindow } from './state/sharingWindow';
import { useSocial } from '../social/state/SocialProvider';
import { requestMapFocus, useMapRequests } from './state/mapRequests';
import { useEvents } from '../events/state/EventsProvider';
import {
  FLASH, PLACEMENT, TOO_MANY_EVENTS_MESSAGE, activeEventCount, crowdingEvent, distanceMeters,
} from '../events/model/eventModel';
import { useTabBarHeight } from '../../components/navigation/tabBarHeight';
import { useTabLinks } from '../../components/navigation/useTabLinks';
import { pressFeedback, tapFeedback } from '../../lib/haptics';
import { resolveAvatar } from '../../../avatar-server/shared/avatarFormat';
import { AVATAR_FILES_URL } from '../avatar/api/avatarServer';
import { useUserAvatar } from '../avatar/state/AvatarProvider';
import { useInternetConnectionIssue } from './hooks/useInternetConnectionIssue';
import { useKeyboardHeight } from './hooks/useKeyboardHeight';
import { usePlayerLocation } from './hooks/usePlayerLocation';
import { useConnectInvite } from '../social/connect/connectInvites';

// A fix this much older than the moment the user came (back) to the map is where they
// were, not where they are: it moves their avatar, it is never shared
const SHARED_FIX_OLDEST_MS = 30_000;

export function MapScreen() {
  const mapRef = useRef(null);
  const screenIsFocused = useRef(false);
  const appIsActive = useRef(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const appHasWindowFocus = useRef(true);
  // Whether the map is on screen: only then it draws
  const syncMapActivity = useCallback(() => {
    mapRef.current?.setActive(screenIsFocused.current && appIsActive.current && appHasWindowFocus.current);
  }, []);
  // The latest GPS fix: the map's player (told when its screen shows: it draws nothing
  // meanwhile), and the user's presence for the server
  const latestFix = useRef(null);
  const positionRef = useRef(null);
  const sharedSince = useRef(0);
  // …and, every 20 m, where the user is for the distances to the people around
  const [here, setHere] = useState(null);
  const publishPosition = useCallback((position) => {
    latestFix.current = position;
    if (position.timestamp >= sharedSince.current - SHARED_FIX_OLDEST_MS) positionRef.current = position;
    if (screenIsFocused.current) mapRef.current?.setPlayerLocation(position);
    setHere((current) => (!current || distanceMeters(current, position) > 20
      ? { latitude: position.latitude, longitude: position.longitude }
      : current));
  }, []);
  // Where the phone last was, before the first GPS fix: the map draws from it, and that is all.
  // It is not in latestFix, positionRef or here: the server never hears of it
  const drawFromLastKnown = useCallback((position) => {
    mapRef.current?.setProvisionalLocation(position);
  }, []);
  // The person whose card is open (tapped on the map), or the user's own card (their
  // avatar tapped: words to everyone around). One card at a time, like the event's.
  const [personId, setPersonId] = useState(null);
  const [selfOpen, setSelfOpen] = useState(false);
  const {
    startTracking,
    stopTracking,
    retryLocationPermission,
    gpsIssue,
  } = usePlayerLocation(publishPosition, drawFromLastKnown);
  const internetIssue = useInternetConnectionIssue();

  // Sharing the position and receiving the people around: on the map and a minute after
  // leaving it, never from the background (sharingWindow.js). The GPS runs as long
  const [sharing, setSharing] = useState(false);
  const [sharingWindow] = useState(() => createSharingWindow({ onChange: setSharing }));
  const wasSharing = useRef(false);
  useEffect(() => {
    if (wasSharing.current && !sharing) {
      positionRef.current = null;
      stopTracking();
    }
    wasSharing.current = sharing;
  }, [sharing, stopTracking]);

  // The player on the map is the user's own avatar (no greeting there)
  const { avatar, catalog } = useUserAvatar();
  useEffect(() => {
    if (!avatar || !catalog || !AVATAR_FILES_URL) return;
    const plan = resolveAvatar(avatar, catalog, AVATAR_FILES_URL);
    mapRef.current?.setPlayerAvatar(plan);
  }, [avatar, catalog]);

  useEffect(() => {
    const subscriptions = [
      AppState.addEventListener('change', (state) => {
        appIsActive.current = state === 'active';
        syncMapActivity();
        if (state !== 'active') sharingWindow.appLeft();
        // Back in front: only a fix from now on says where the user is
        else if (positionRef.current) {
          positionRef.current = null;
          sharedSince.current = Date.now();
        }
      }),
    ];
    // `blur` and `focus` exist only on Android; on iOS the `inactive` state covers them
    if (Platform.OS === 'android') {
      subscriptions.push(
        AppState.addEventListener('blur', () => {
          appHasWindowFocus.current = false;
          syncMapActivity();
        }),
        AppState.addEventListener('focus', () => {
          appHasWindowFocus.current = true;
          syncMapActivity();
        }),
      );
    }

    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [syncMapActivity, sharingWindow]);

  // Events as beacons on the map; a tapped one is shown in a card while the camera
  // looks at it. A long press makes a flash event right there.
  const mapEvents = useMapEvents();
  const { byId, user, notePosition } = useEvents();
  // The events around follow the user: distances in the lists, a new search once far away
  useEffect(() => {
    if (here) notePosition(here);
  }, [here, notePosition]);
  const requests = useMapRequests();
  // The event in view: chosen on the map, or just made (FlashEventScreen)
  const selectedId = requests.focus;
  const selected = selectedId ? byId[selectedId] : null;
  const shownEvent = selected && mapEvents.some((event) => event.id === selectedId) ? selected : null;
  const tabBarHeight = useTabBarHeight();
  const links = useTabLinks();
  const [toast, setToast] = useState(null);
  const announce = useCallback((text) => setToast({ text, id: Date.now() }), []);
  // The height of the card open over the map (one at a time): a line shown meanwhile
  // goes just above it, also when the keyboard lifts the card
  const [cardHeight, setCardHeight] = useState(0);
  const keyboard = useKeyboardHeight();
  // "Connect" on someone: the server picks the method for the two phones and invites them
  const connectWith = useConnectInvite();

  useEffect(() => {
    mapRef.current?.setEvents(mapEvents);
  }, [mapEvents]);

  const openEvent = useCallback((id) => {
    tapFeedback();
    setPersonId(null);
    setSelfOpen(false);
    requestMapFocus(id);
  }, []);
  const closeEvent = useCallback(() => requestMapFocus(null), []);
  const onMapTap = useCallback(() => {
    if (selectedId) closeEvent();
    setPersonId(null);
    setSelfOpen(false);
  }, [selectedId, closeEvent]);
  const onLongPress = useCallback((point) => {
    pressFeedback();
    setPersonId(null);
    setSelfOpen(false);
    if (selectedId) closeEvent();
    // No sheet for an event that could not be made (the server checks again): too many
    // on, another one here (it would be drawn on top of it), or too far from the player
    // (a flash event is for right around them)
    if (point.player && distanceMeters(point.player, point) > FLASH.maxDistance) {
      announce(`Flash events are for right around you: hold the map within ${FLASH.maxDistance} m of your avatar.`);
      return;
    }
    const known = Object.values(byId);
    if (user && activeEventCount(known, user.id) >= PLACEMENT.maxActive) {
      announce(TOO_MANY_EVENTS_MESSAGE);
      return;
    }
    const crowding = crowdingEvent(known, { location: point });
    if (crowding) {
      announce(`Too close to “${crowding.title}”. Hold the map at least ${PLACEMENT.minSpacingMeters} m away from it.`);
      return;
    }
    router.push({
      pathname: '/flash-event',
      params: {
        latitude: String(point.latitude),
        longitude: String(point.longitude),
        // Where the user is, sent with it (the server checks the distance)
        ...(point.player ? { fromLatitude: String(point.player.latitude), fromLongitude: String(point.player.longitude) } : {}),
      },
    });
  }, [selectedId, closeEvent, byId, user, announce]);

  // The camera flies to the event in view, and back to the player without one (also
  // when the event ends and leaves the map)
  const inView = shownEvent ? selectedId : null;
  useEffect(() => {
    mapRef.current?.focusEvent(inView);
  }, [inView]);

  // The place of a flash event being made, marked while its sheet is open
  useEffect(() => {
    mapRef.current?.setDraftPin(requests.draft);
  }, [requests.draft]);

  // The live weather at the player (the map makes no request of its own but its tiles
  // and avatar files)
  useMapWeather(mapRef, here);

  // The people around (docs/API.md, WebSocket): sent by the server while the app is
  // in front and the user is not invisible; a tapped one is shown in a card
  const [mode] = useMapMode();
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  usePresenceSync({ mode, positionRef, sharing });
  const { people, emoteFor } = useMapPeople(mapRef, here);
  const shownPerson = personId ? people.find((entry) => entry.userId === personId) ?? null : null;
  const { isConnection, canMessage, openDirect, send, chats } = useSocial();
  // The direct chat with someone on the map (made on the server when first used)
  const openChatWith = useCallback((userId) => {
    openDirect(userId)
      .then((chatId) => router.push({ pathname: '/chat/[id]', params: { id: chatId } }))
      .catch(() => announce('You can\'t write to them right now'));
  }, [openDirect, announce]);
  const writeTo = useCallback((userId, text) => {
    openDirect(userId)
      .then((chatId) => send(chatId, text))
      .catch(() => announce('Could not send it, try again'));
  }, [openDirect, send, announce]);
  // The camera frames the two of you once, not at every step they take
  const framedId = shownPerson?.userId ?? null;
  useEffect(() => {
    mapRef.current?.selectPerson(framedId);
  }, [framedId]);

  // Gestures: yours at them, played on your avatar; theirs at you, on theirs (they
  // see yours on their map the same way)
  const sendGesture = useSendGesture();
  const makeGesture = useCallback((to, gestureId) => {
    const gesture = gestureInfo(gestureId);
    if (!gesture) return;
    mapRef.current?.playGesture({ from: 'me', to, url: emoteFor('me', gestureId), emoji: gesture.emoji });
    sendGesture(to, gestureId).catch((error) => {
      if (error?.code === 'rate_limited') return;
      announce(error?.code === 'forbidden' ? 'They can\'t see you on the map now' : 'Could not reach them, try again');
    });
  }, [emoteFor, sendGesture, announce]);
  const onIncomingGesture = useCallback((incoming) => {
    const gesture = gestureInfo(incoming.gesture);
    if (!gesture) return;
    mapRef.current?.playGesture({ from: incoming.from, to: 'me', url: emoteFor(incoming.from, incoming.gesture), emoji: gesture.emoji });
  }, [emoteFor]);
  useIncomingGestures(onIncomingGesture);

  // Words: a message with someone on the map shows over the head of who wrote it
  useMapBubbles(mapRef, people, chats);
  const openPerson = useCallback((id) => {
    tapFeedback();
    requestMapFocus(null);
    setSelfOpen(false);
    setPersonId(id);
  }, []);
  const closePerson = useCallback(() => setPersonId(null), []);

  // Words to everyone around: the user taps their own avatar (the view stays as it is),
  // and what they write shows over their head on the map of everyone who sees them
  // (docs/API.md, `broadcast` frames); what others say to everyone shows over theirs
  const audience = useMapAudience(mode);
  const openSelf = useCallback(() => {
    tapFeedback();
    requestMapFocus(null);
    setPersonId(null);
    setSelfOpen(true);
  }, []);
  const closeSelf = useCallback(() => setSelfOpen(false), []);
  const sendBroadcast = useSendBroadcast();
  const lastBroadcast = useRef(0);
  const broadcast = useCallback((text) => {
    const now = Date.now();
    if (now - lastBroadcast.current < BROADCAST_COOLDOWN_MS) {
      announce('Wait a few seconds before the next one');
      return;
    }
    lastBroadcast.current = now;
    setSelfOpen(false);
    mapRef.current?.showBubble({ from: 'me', text, everyone: true });
    sendBroadcast(text)
      .then(({ recipients }) => {
        if (Number.isFinite(recipients)) announce(recipients === 1 ? 'Sent to 1 person nearby' : `Sent to ${recipients} people nearby`);
      })
      .catch((error) => {
        if (error?.status !== 429) lastBroadcast.current = 0;
        announce(error?.status === 429 ? 'Wait a few seconds before the next one' : 'Could not send it, try again');
      });
  }, [sendBroadcast, announce]);
  const onIncomingBroadcast = useCallback((incoming) => {
    mapRef.current?.showBubble({ from: incoming.from, text: incoming.text, everyone: true });
  }, []);
  useIncomingBroadcasts(onIncomingBroadcast);


  useFocusEffect(
    useCallback(() => {
      screenIsFocused.current = true;
      syncMapActivity();
      if (latestFix.current) mapRef.current?.setPlayerLocation(latestFix.current);
      if (!sharingWindow.sharing()) sharedSince.current = Date.now();
      sharingWindow.enter();
      startTracking();
      return () => {
        screenIsFocused.current = false;
        syncMapActivity();
        // Invisible nothing is shared: no reason to keep the GPS on for a minute
        sharingWindow.leave({ now: modeRef.current === 'invisible' });
      };
    }, [startTracking, sharingWindow, syncMapActivity]),
  );

  return (
    <View style={styles.container}>
      <MapWebView ref={mapRef} onEventTap={openEvent} onMapTap={onMapTap} onLongPress={onLongPress} onPersonTap={openPerson} onPlayerTap={openSelf} />
      <VisibilitySwitch onAnnounce={announce} />
      <MapStatusIndicators
        gpsIssue={gpsIssue}
        internetIssue={internetIssue}
        onLocationPermissionPress={retryLocationPermission}
      />
      <EventMapCard
        event={shownEvent}
        bottom={tabBarHeight + 12}
        onClose={closeEvent}
        onOpen={() => shownEvent && router.push(links.event(shownEvent.id))}
        onHeight={setCardHeight}
      />
      <PersonMapCard
        person={shownPerson}
        distance={shownPerson?.distance}
        connected={!!shownPerson && isConnection(shownPerson.userId)}
        canWrite={!!shownPerson && canMessage(shownPerson.userId)}
        bottom={tabBarHeight + 12}
        onClose={closePerson}
        onProfile={() => shownPerson && router.push(links.user(shownPerson.userId, { username: shownPerson.username, name: shownPerson.name }))}
        onChat={() => shownPerson && openChatWith(shownPerson.userId)}
        onConnect={() => shownPerson && connectWith({ id: shownPerson.userId, name: shownPerson.name }).then((result) => {
          if (result === 'already') announce(`You and ${shownPerson.name} are already connected`);
        })}
        onGesture={(gestureId) => shownPerson && makeGesture(shownPerson.userId, gestureId)}
        onSend={(text) => shownPerson && writeTo(shownPerson.userId, text)}
        onHeight={setCardHeight}
      />
      <BroadcastMapCard
        open={selfOpen}
        audience={audience.total}
        invisible={mode === 'invisible'}
        bottom={tabBarHeight + 12}
        onClose={closeSelf}
        onSend={broadcast}
        onHeight={setCardHeight}
      />
      <MapToast
        message={toast}
        bottom={shownEvent || shownPerson || selfOpen
          ? (keyboard && !shownEvent ? keyboard + 8 : tabBarHeight + 12) + cardHeight + 10
          : tabBarHeight + 16}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
