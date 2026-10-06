import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polishStory } from './fixtures/presentation-polish.mjs';
import {
  newestAircraftPosition,
  storyAircraftPosition,
  storyWithSharedAircraftPosition,
} from '../src/lib/shared-aircraft-position.ts';

test('AA5074 Ground and Flight both keep the newer off-runway story position', () => {
  const base = polishStory();
  const nowMs = base.fetchedAt;
  const nowSec = nowMs / 1000;
  const story = {
    ...base,
    aircraft: { ...base.aircraft, lat: 39.8761, lon: -75.2324, onGround: true, altFt: 0, gsKt: 18 },
    providers: { chosenPosition: 'adsb', chosenPositionSeenAt: nowSec - 4, chosenPositionAgeSec: 4 },
  };
  const runwayGroundFix = {
    ...story.aircraft,
    lat: 39.8729,
    lon: -75.2481,
    seenAt: nowSec - 52,
    provider: 'flightaware-public',
  };

  const selected = newestAircraftPosition(storyAircraftPosition(story, nowMs), runwayGroundFix);
  const flightViewStory = storyWithSharedAircraftPosition(story, selected, nowMs);
  const groundViewStory = storyWithSharedAircraftPosition(story, selected, nowMs);

  assert.deepEqual(
    [flightViewStory.aircraft.lat, flightViewStory.aircraft.lon],
    [39.8761, -75.2324],
  );
  assert.deepEqual(
    [groundViewStory.aircraft.lat, groundViewStory.aircraft.lon],
    [flightViewStory.aircraft.lat, flightViewStory.aircraft.lon],
  );
  assert.equal(groundViewStory.providers.chosenPositionAgeSec, 4);
});

test('a newer Ground poll becomes the one shared position for every map tab', () => {
  const base = polishStory();
  const nowMs = base.fetchedAt;
  const nowSec = nowMs / 1000;
  const story = {
    ...base,
    providers: { chosenPosition: 'flightaware-public', chosenPositionSeenAt: nowSec - 25, chosenPositionAgeSec: 25 },
  };
  const newerGroundFix = {
    ...story.aircraft,
    lat: story.aircraft.lat + 0.01,
    lon: story.aircraft.lon - 0.01,
    seenAt: nowSec - 2,
    provider: 'adsb',
  };
  const selected = newestAircraftPosition(storyAircraftPosition(story, nowMs), newerGroundFix);
  const shared = storyWithSharedAircraftPosition(story, selected, nowMs);

  assert.equal(selected, newerGroundFix);
  assert.deepEqual([shared.aircraft.lat, shared.aircraft.lon], [newerGroundFix.lat, newerGroundFix.lon]);
  assert.equal(shared.providers.chosenPosition, 'adsb');
  assert.equal(shared.providers.chosenPositionAgeSec, 2);
});

test('a shared position older than 60 seconds is not live', () => {
  const base = polishStory();
  const nowMs = base.fetchedAt;
  const stale = {
    ...base.aircraft,
    seenAt: nowMs / 1000 - 61,
    provider: 'flightaware-public',
  };
  const shared = storyWithSharedAircraftPosition(base, stale, nowMs);
  assert.equal(shared.live, false);
  assert.equal(shared.providers.chosenPositionAgeSec, 61);
});
