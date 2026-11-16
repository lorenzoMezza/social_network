// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { createEventInCalendarAsync } from 'expo-calendar/legacy';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { IconButton } from '../../../components/ui/IconButton';
import { Notice } from '../../../components/ui/Notice';
import { PopoverMenu } from '../../../components/ui/PopoverMenu';
import { ActionSheet } from '../../../components/ui/ActionSheet';
import { useTabBarHeight } from '../../../components/navigation/tabBarHeight';
import { useTabLinks } from '../../../components/navigation/useTabLinks';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { useEvent, useEvents } from '../state/EventsProvider';
import { CategoryTile } from '../components/CategoryTile';
import { EventCover } from '../components/EventCover';
import { EventBackdrop } from '../components/EventBackdrop';
import { Stars } from '../components/Stars';
import { EmptyState, ErrorState } from '../../../components/ui/StateViews';
import { categoryLine, eventColor } from '../model/categories';
import { cleanTheme, pageColor, titleFont, useThemePreview, withAlpha } from '../model/eventTheme';
import { EventPhotosSection, albumLink } from '../../album/components/EventPhotosSection';
import { useAddPhotos } from '../../album/hooks/useAddPhotos';
import { canPost } from '../../album/model/albumModel';
import { useAlbums } from '../../album/state/AlbumsProvider';
import { PersonAvatar } from '../../social/components/PersonAvatar';
import { useSocial } from '../../social/state/SocialProvider';
import { formatCredits, formatRadius, promotionRow } from '../../promotions/model/promotionModel';
import { usePromotions } from '../../promotions/state/PromotionsProvider';
import {
  averageRating, canRate, distanceMeters, isFull, eventAddress, eventStatus, formatDay, formatDistance, formatLongDay, formatTime, goingLine, joinRefusal, LEAVE_EVENT, safeWebLink, spotsLine, STATUS, statusLine,
} from '../model/eventModel';
import { failureMessage } from '../../api/failureMessage';

const FACES = 3;

// One event, and each thing on it once: the rows say when and where and offer what goes
// with them (the calendar, the way there), the people have one line in the words of the
// list. What comes first follows the event: before and during it, what it is and who
// goes; once over, how it went (photos, ratings). The main action stays at the bottom,
// within thumb's reach, above the tab bar when the event was opened inside a tab, and
// there is no bar when nothing is left to do.
export function EventDetailScreen({ id }) {
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();
  const links = useTabLinks();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { event, status, error, reload } = useEvent(id);
  const { user, position, isGoing, setGoing, isSaved, setSaved, cancelEvent, reloadEvent } = useEvents();
  const { isConnection } = useSocial();
  const { refreshWallet } = usePromotions();
  const [followBusy, setFollowBusy] = useState(false);
  const [showFollowers, setShowFollowers] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The look being tried in the style sheet over this page, before it is saved
  const preview = useThemePreview(id);
  const { albums } = useAlbums();
  // Photos added from here: the album opens, where they are seen being sent
  const adder = useAddPhotos(id, { onAdded: () => router.push(albumLink(id)) });

  const back = () => (router.canGoBack() ? router.back() : router.replace('/events'));

  if (!event?.dates?.startDate) {
    return (
      <View style={[styles.page, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <IconButton icon="chevron-back" label="Back" onPress={back} />
        </View>
        <View style={styles.centered}>
          {status === 'error' ? (
            error?.status === 404
              ? <EmptyState icon="calendar-clear-outline" title="Event not found" message="The organizer may have removed it." actionLabel="Back to events" onAction={back} />
              : <ErrorState error={error} onRetry={reload} subject="The event" />
          ) : <ActivityIndicator color={colors.inactive} />}
        </View>
      </View>
    );
  }

  const isOwner = !!user && event.creatorId === user.id;
  const following = isGoing(event.id);
  const saved = isSaved(event.id);
  const current = eventStatus(event);
  const cancelled = current === STATUS.cancelled;
  const over = current === STATUS.concluded;
  const finished = over || cancelled;
  const ratings = event.ratings ?? [];
  const ownRating = event.myRating ?? null;
  const otherRatings = ratings.filter((rating) => rating.user?.id !== user?.id);
  // The server's totals cover every rating; the list holds only the newest ones
  const ratingCount = event.ratingCount ?? ratings.length;
  const average = event.ratingCount != null ? event.ratingAverage ?? null : averageRating(ratings);
  const rateable = canRate(event, user?.id);
  const followers = event.followers ?? [];
  // The total: the list holds the first ones only for big events
  const going = Math.max(event.followerCount ?? 0, followers.length);
  const start = new Date(event.dates.startDate);
  const end = new Date(event.dates.endDate);
  const sameDay = start.toDateString() === end.toDateString();
  const distance = formatDistance(distanceMeters(position, event.location));
  // Flash events (made on the map, starting within the hour) have no photo, link or
  // address: what their sheet does not ask for is not shown
  const flash = !!event.flash;
  // Its organizer's style (eventTheme.js): colour, symbol, background, title; and its pictures
  const theme = cleanTheme(preview ? preview.theme : event.theme);
  const tone = eventColor({ ...event, theme });
  const accent = theme.color ?? colors.active;
  const actionColor = theme.color ?? colors.accent;
  const background = pageColor(theme, tone, colors);
  const photos = flash ? [] : event.imageUrls ?? [];
  // Written by the organizer: only a web link is offered
  const website = flash ? null : safeWebLink(event.links);
  const statusColor = current === STATUS.ongoing ? colors.live : cancelled ? colors.error : finished ? colors.inactive : accent;
  const statusText = statusLine(event);
  const spotsText = flash && !finished ? spotsLine(event) : null;
  const postable = canPost(event, albums[event.id]?.settings, user);

  // Join: the user is going (on its people, its chat and its album). Leaving asks
  // first: it takes them out of all of that
  const join = async (going) => {
    setFollowBusy(true);
    try {
      await setGoing(event.id, going);
      if (going) successFeedback();
      else tapFeedback();
    } catch (error) {
      // What the server knows and this page did not: shown as it is now
      if (error?.status && error.status !== 0 && error.status < 500) reloadEvent(event.id);
      const refusal = joinRefusal(error);
      if (refusal) Alert.alert(refusal.title, refusal.message);
      else Alert.alert('Could not update', failureMessage(error));
    } finally {
      setFollowBusy(false);
    }
  };
  const toggleJoin = () => {
    if (!following) {
      join(true);
      return;
    }
    Alert.alert(LEAVE_EVENT.title, LEAVE_EVENT.message, [
      { text: 'Stay', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => join(false) },
    ]);
  };
  // Save: a private bookmark, to find it again in Saved (nobody is told)
  const toggleSave = () => {
    tapFeedback();
    setSaved(event.id, !saved).catch((error) => Alert.alert('Could not update', failureMessage(error)));
  };

  const edit = () => router.push({ pathname: flash ? '/flash-event' : '/event-editor', params: { id: event.id } });
  const restyle = () => router.push({ pathname: '/event-style', params: { id: event.id } });
  const rate = () => router.push({ pathname: '/event-rating', params: { id: event.id } });
  const report = () => router.push({ pathname: '/event-report', params: { id: event.id } });

  const confirmCancel = () => {
    // What was paid to promote it and not used yet comes back (the server counts it)
    const back = event.promotion?.refundable > 0 ? `Up to ${formatCredits(event.promotion.refundable)} of promotion not used comes back to your credits. ` : '';
    Alert.alert(
      'Cancel this event?',
      `${going ? `The ${going === 1 ? 'person' : `${going} people`} going will be told. ` : ''}${back}You cannot undo this.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel event',
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelEvent(event.id);
              if (event.promotion) refreshWallet().catch(() => {});
            } catch (error) {
              Alert.alert('Could not cancel', failureMessage(error));
            }
          },
        },
      ],
    );
  };

  // Each action once, in sight: the organizer's are in the bar and at the top (who can add
  // photos is in the album's own settings); the others only have this
  const menu = isOwner ? [] : [{ label: 'Report event', icon: 'flag-outline', onPress: report, destructive: true }];

  const openMenu = () => setMenuOpen(true);

  const openLink = () => {
    if (website) WebBrowser.openBrowserAsync(website).catch(() => Alert.alert('Could not open the link'));
  };

  // The phone's own "New event" screen, filled in: the user picks the calendar and
  // saves (nothing is read from their calendars)
  const addToCalendar = async () => {
    tapFeedback();
    try {
      await createEventInCalendarAsync({
        title: event.title,
        startDate: start,
        endDate: end,
        // A real address only
        location: eventAddress(event) ?? undefined,
        notes: event.description,
        url: website ?? undefined,
      });
    } catch {
      Alert.alert('Could not open the calendar');
    }
  };

  const directions = () => {
    tapFeedback();
    const { latitude, longitude } = event.location ?? {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const label = encodeURIComponent(event.title);
    const url = process.env.EXPO_OS === 'ios'
      ? `maps://?daddr=${latitude},${longitude}&q=${label}`
      : `geo:${latitude},${longitude}?q=${latitude},${longitude}(${label})`;
    Linking.openURL(url).catch(() => Alert.alert('Could not open the maps'));
  };

  const share = () => {
    tapFeedback();
    const when = sameDay
      ? `${formatLongDay(start)}, ${formatTime(start)} – ${formatTime(end)}`
      : `${formatDay(start)} ${formatTime(start)} – ${formatDay(end)} ${formatTime(end)}`;
    Share.share({ message: [event.title, when, eventAddress(event), website].filter(Boolean).join('\n') }).catch(() => {});
  };

  // What the rows offer, only while it can be of use: a flash event starts within the
  // hour and one already started needs no calendar, one that is over no way there
  const canCalendar = current !== STATUS.ongoing && !finished && !flash;
  const canDirections = !finished && !!event.location;
  const hours = `${formatTime(start)} – ${formatTime(end)}`;
  const address = flash ? null : eventAddress(event);
  const placeTitle = address || (!finished && distance ? `${distance} away` : isOwner ? 'Where you pinned it' : 'Pinned on the map');

  const about = <Text style={styles.description} selectable>{event.description}</Text>;

  const photosSection = <EventPhotosSection event={event} user={user} onAdd={finished ? undefined : adder.open} />;

  // The same words as the event's card in the lists
  const goingText = goingLine({ ...event, following });
  // Over with nobody there: nothing to say about it
  const peopleSection = finished && !going ? null : (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{cancelled ? 'Who was going' : over ? 'Who went' : "Who's going"}</Text>
      {followers.length ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${goingText}, ${showFollowers ? 'hide' : 'show'} names`} onPress={() => setShowFollowers((value) => !value)} style={styles.faces}>
          <View style={styles.faceStack}>
            {followers.slice(0, FACES).map((person, index) => (
              <View key={person.id} style={[styles.face, index > 0 && styles.faceOverlap]}>
                <PersonAvatar person={person} size={28} />
              </View>
            ))}
          </View>
          <Text style={styles.facesText}>{goingText}</Text>
          <Ionicons name={showFollowers ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inactive} />
        </Pressable>
      ) : going ? (
        // People are going, none of them shown to the user (they keep it to their connections)
        <Text style={styles.muted}>{goingText}</Text>
      ) : (
        <Text style={styles.muted}>{isOwner ? 'Nobody has joined yet. Share it with your friends.' : 'Nobody yet: be the first to join.'}</Text>
      )}
      {showFollowers ? (
        <View style={styles.people}>
          {followers.map((person) => {
            const self = person.id === user?.id;
            return (
              <Pressable
                key={person.id}
                accessibilityRole="button"
                disabled={self}
                onPress={() => router.push(links.user(person.id, { username: person.username, name: person.name }))}
                style={({ pressed }) => [styles.personRow, pressed && styles.pressed]}
              >
                <PersonAvatar person={person} size={32} />
                <Text style={styles.personName} numberOfLines={1}>{self ? 'You' : person.name}</Text>
                {/* The user's connections come first (the server's order), marked */}
                {!self && isConnection(person.id) ? <Text style={styles.connectionTag}>Connection</Text> : (
                  <Text style={styles.personHandle} numberOfLines={1}>@{person.username}</Text>
                )}
              </Pressable>
            );
          })}
          {going > followers.length ? <Text style={styles.muted}>{`and ${going - followers.length} more`}</Text> : null}
        </View>
      ) : null}
    </View>
  );

  const ratingsSection = ratingCount || rateable ? (
    <View style={styles.section}>
      <View style={styles.ratingsHeader}>
        <Text style={styles.sectionTitle}>Ratings</Text>
        {average != null ? (
          <View style={styles.average}>
            <Stars value={average} size={13} />
            <Text style={styles.averageText}>{(average / 2).toFixed(1)} ({ratingCount})</Text>
          </View>
        ) : null}
      </View>
      {ownRating ? <Rating styles={styles} rating={ownRating} own onEdit={rate} /> : null}
      {!ownRating && rateable ? (
        <Pressable accessibilityRole="button" onPress={rate} style={({ pressed }) => [styles.rateRow, pressed && styles.pressed]}>
          <Stars value={0} size={20} />
          <Text style={styles.rateText}>{current === STATUS.ongoing ? 'How is it going?' : 'How was it?'}</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.inactive} />
        </Pressable>
      ) : null}
      {otherRatings.map((rating) => <Rating key={rating.id} styles={styles} rating={rating} />)}
    </View>
  ) : null;

  // The main action, if anything is left to do. Once over, that is adding its photos
  // (the strip on the page opens the album)
  let actions = null;
  if (over && postable) {
    actions = <Button label="Add photos" icon="images-outline" onPress={adder.open} />;
  } else if (!finished && isOwner) {
    // Its content, and its look: two things a new organizer should see at once. Neither
    // once it is over: what took place stays as it took place (the server refuses, 410)
    actions = (
      <View style={styles.actionRow}>
        <Button label="Edit event" icon="create-outline" variant="secondary" onPress={edit} style={styles.flex} />
        <Button label="Style" icon="color-palette-outline" variant="secondary" onPress={restyle} style={styles.styleButton} />
      </View>
    );
  } else if (!finished) {
    // Join, the main thing; Save beside it, a bookmark (not for flash events: they are
    // over in a few hours)
    actions = (
      <View style={styles.actionRow}>
        <Button
          label={following ? 'Going' : isFull(event) ? 'Full' : 'Join'}
          icon={following ? 'checkmark' : isFull(event) ? undefined : 'add'}
          variant={following ? 'secondary' : 'primary'}
          busy={followBusy}
          disabled={!following && isFull(event)}
          onPress={toggleJoin}
          style={styles.flex}
        />
        {flash ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={saved ? 'Saved, remove from Saved' : 'Save'}
            accessibilityState={{ selected: saved }}
            onPress={toggleSave}
            style={({ pressed }) => [styles.saveButton, pressed && styles.pressed]}
          >
            <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={22} color={saved ? colors.accent : colors.active} />
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.page, { paddingTop: insets.top, backgroundColor: background }]}>
      <EventBackdrop theme={theme} tone={tone} dark={colors.scheme === 'dark'} height={insets.top + 420} inset={insets.top} />
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={back} />
        <View style={styles.topActions}>
          {cancelled ? null : <IconButton icon="share-outline" label="Share" onPress={share} />}
          {isOwner && !finished ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={6}
              onPress={confirmCancel}
              style={({ pressed }) => [styles.cancelEvent, pressed && styles.pressed]}
            >
              <Text style={styles.cancelEventLabel}>Cancel event</Text>
            </Pressable>
          ) : null}
          {menu.length ? <IconButton icon="ellipsis-horizontal" label="More actions" onPress={openMenu} /> : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: (actions ? 112 : 32) + (tabBarHeight || insets.bottom) }]} showsVerticalScrollIndicator={false}>
        {/* Its pictures, only when its organizer gave some */}
        {photos.length ? <EventCover photos={photos} label={`Photo of ${event.title}`} own={following || isOwner} style={styles.cover} /> : null}

        <View style={styles.kind}>
          <CategoryTile event={event} theme={theme} size={36} />
          <Text style={styles.kindText} numberOfLines={1}>
            {flash ? '⚡ Flash · ' : ''}{!isOwner && event.sponsored ? <Text style={styles.sponsored}>Sponsored · </Text> : null}{categoryLine(event, 3) || 'Event'}
          </Text>
        </View>
        <Text style={[styles.title, titleFont(theme.title)]} accessibilityRole="header" selectable>{event.title}</Text>
        {cancelled ? (
          <View style={styles.cancelled}>
            <Notice icon="close-circle" text={isOwner ? 'You cancelled this event. It will not take place.' : 'The organizer cancelled this event. It will not take place.'} />
          </View>
        ) : (
          statusText || spotsText ? (
            <Text style={[styles.status, { color: statusColor }]}>
              {statusText}
              {spotsText ? <Text style={styles.spots}>{statusText ? `  ·  ${spotsText}` : spotsText}</Text> : null}
            </Text>
          ) : null
        )}

        <View style={styles.facts}>
          <Fact styles={styles} colors={colors} icon="calendar-outline"
            title={finished
              ? (sameDay ? formatLongDay(start) : `${formatDay(start)} to ${formatDay(end)}`)
              : (sameDay ? `${formatDay(start)}, ${hours}` : `${formatDay(start)} ${formatTime(start)} – ${formatDay(end)} ${formatTime(end)}`)}
            subtitle={finished ? hours : null}
            action={canCalendar ? 'Add to calendar' : null}
            actionColor={actionColor}
            onPress={canCalendar ? addToCalendar : undefined}
          />
          {!finished || address ? (
            <Fact styles={styles} colors={colors} icon="location-outline"
              title={placeTitle}
              subtitle={address && distance && !finished ? `${distance} away` : null}
              action={canDirections ? 'Get directions' : null}
              actionColor={actionColor}
              onPress={canDirections ? directions : undefined}
            />
          ) : null}
          {website ? (
            <Fact styles={styles} colors={colors} icon="globe-outline" title="Website" subtitle={hostOf(website)} onPress={openLink} external />
          ) : null}
          {!isOwner && event.creator ? (
            <Fact
              styles={styles}
              colors={colors}
              person={event.creator}
              title={event.creator.name || `@${event.creator.username}`}
              // Paid promotion (docs/PROMOTIONS.md): said plainly to everyone who sees
              // it, with who pays and how far it is shown (what an ad must tell)
              subtitle={event.sponsored ? `Organizer, promoted within ${formatRadius(event.reach)}` : 'Organizer'}
              onPress={() => router.push(links.user(event.creator.id, { username: event.creator.username, name: event.creator.name }))}
              chevron
            />
          ) : null}
        </View>

        {over ? (
          <>
            {photosSection}
            {ratingsSection}
            {peopleSection}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>About</Text>
              {about}
            </View>
          </>
        ) : (
          <>
            <View style={styles.aboutTop}>{about}</View>
            {photosSection}
            {peopleSection}
            {ratingsSection}
            {isOwner && !flash && !finished ? (
              <View style={styles.promote}>
                <Fact styles={styles} colors={colors} icon="megaphone-outline" {...promotionRow(event)}
                  onPress={() => router.push({ pathname: '/event-promote', params: { id: event.id } })}
                  chevron
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* Down to the bottom of the screen, behind the floating tab bar: nothing scrolls
          between the buttons and the bar; the page fades out just above the buttons */}
      {actions ? (
        <View style={[styles.actionBar, { backgroundColor: background, paddingBottom: tabBarHeight ? tabBarHeight + 10 : Math.max(insets.bottom, 12) }]}>
          <View pointerEvents="none" style={[styles.actionFade, { experimental_backgroundImage: `linear-gradient(to bottom, ${withAlpha(background, 0)}, ${background})` }]} />
          {actions}
        </View>
      ) : null}

      {/* Under the ⋯ button: top bar (6 + 40 + 6) below the safe area */}
      <PopoverMenu visible={menuOpen} onClose={() => setMenuOpen(false)} top={insets.top + 52} right={16} items={menu} />
      <ActionSheet {...adder.sheet} />
    </View>
  );
}

// The name of a web link, without what nobody reads
function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return link;
  }
}

// A line of facts: an icon, or a person's picture (`person`, a UserSummary). `action`
// names, in words, what touching it does; `chevron` opens a page, `external` leaves the app
function Fact({ styles, colors, icon, person, title, subtitle, action, actionColor, onPress, chevron, external }) {
  const content = (
    <View style={styles.fact}>
      {person ? <PersonAvatar person={person} size={24} /> : <Ionicons name={icon} size={20} color={colors.inactive} />}
      <View style={styles.flex}>
        <Text style={styles.factTitle}>{title}</Text>
        {subtitle || action ? (
          <Text style={styles.factSubtitle} numberOfLines={2}>
            {subtitle}{subtitle && action ? '  ·  ' : ''}
            {action ? <Text style={[styles.factAction, { color: actionColor }]}>{action}</Text> : null}
          </Text>
        ) : null}
      </View>
      {chevron ? <Ionicons name="chevron-forward" size={16} color={colors.inactive} /> : null}
      {external ? <Ionicons name="arrow-up-outline" size={16} color={colors.inactive} style={styles.external} /> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable accessibilityRole={external ? 'link' : 'button'} onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      {content}
    </Pressable>
  );
}

function Rating({ styles, rating, own, onEdit }) {
  return (
    <View style={styles.rating}>
      <View style={styles.ratingTop}>
        <PersonAvatar person={rating.user} size={22} />
        <Text style={styles.ratingUser} numberOfLines={1}>{own ? 'You' : rating.user?.name ?? 'Someone'}</Text>
        <Stars value={rating.rating} size={12} />
        <View style={styles.flex} />
        {own ? (
          <Pressable accessibilityRole="button" hitSlop={10} onPress={onEdit}>
            <Text style={styles.editLink}>Edit</Text>
          </Pressable>
        ) : rating.date ? <Text style={styles.ratingDate}>{formatDay(new Date(rating.date))}</Text> : null}
      </View>
      {rating.comment ? <Text style={styles.ratingComment}>{rating.comment}</Text> : null}
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: {
    flex: 1,
  },
  pressed: {
    opacity: 0.6,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  topActions: {
    flexDirection: 'row',
    gap: 8,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  cover: {
    marginBottom: 20,
  },
  kind: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  kindText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.inactive,
  },
  sponsored: {
    color: colors.gold,
    fontWeight: '600',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
    lineHeight: 33,
    color: colors.active,
    marginTop: 14,
  },
  // Who a flash event is looking for, beside the time
  spots: {
    color: colors.active,
  },
  status: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 6,
  },
  cancelled: {
    marginTop: 12,
  },
  facts: {
    marginTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  fact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  factTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.active,
  },
  factSubtitle: {
    fontSize: 14,
    color: colors.inactive,
    marginTop: 1,
  },
  factAction: {
    fontWeight: '600',
  },
  external: {
    transform: [{ rotate: '45deg' }],
  },
  aboutTop: {
    marginTop: 20,
  },
  description: {
    fontSize: 16,
    lineHeight: 25,
    color: colors.active,
  },
  promote: {
    marginTop: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  section: {
    marginTop: 32,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.active,
  },
  faces: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  faceStack: {
    flexDirection: 'row',
  },
  face: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.page,
    borderWidth: 2,
    borderColor: colors.page,
  },
  faceOverlap: {
    marginLeft: -10,
  },

  facesText: {
    flex: 1,
    fontSize: 15,
    color: colors.active,
  },
  people: {
    gap: 2,
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  personName: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.active,
  },
  personHandle: {
    flex: 1,
    fontSize: 14,
    color: colors.inactive,
  },
  muted: {
    fontSize: 15,
    color: colors.inactive,
  },
  ratingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  average: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  averageText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
    fontVariant: ['tabular-nums'],
  },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  rateText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.active,
  },
  rating: {
    gap: 4,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  ratingTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ratingUser: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
  },
  ratingDate: {
    fontSize: 13,
    color: colors.inactive,
  },
  editLink: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
  },
  ratingComment: {
    fontSize: 15,
    lineHeight: 21,
    color: colors.active,
  },
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 6,
    backgroundColor: colors.page,
  },
  actionFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: -32,
    height: 32,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  styleButton: {
    paddingHorizontal: 18,
  },
  cancelEvent: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.pill,
  },
  cancelEventLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.error,
  },
  // The bookmark beside Join: a square of the same height
  saveButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.pill,
  },
  connectionTag: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accent,
  },
});
