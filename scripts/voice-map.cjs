#!/usr/bin/env node
/**
 * voice-map.cjs — pick an Edge-TTS voice for a given YouTube channel.
 *
 * Goal: variety across the catalog so a long playlist doesn't feel like
 * one robot, plus a small bit of identity per channel. Voice choices are
 * keyed by channel id (UC...) — populate as channels are added.
 *
 * Edit the map to taste. To override per-channel at runtime without code
 * changes, set EDGE_TTS_VOICE — that takes precedence for everything.
 */

'use strict';

const DEFAULT_VOICE = 'en-US-AvaMultilingualNeural';

// Keys: YouTube channel IDs (UC...). Values: Edge-TTS voice names.
// Examples to taste — replace as you add channels:
//   'UCXuqSBlHAE6Xw-yeJA0Tunw' : 'en-US-AndrewMultilingualNeural', // LTT — tech
//   'UCsXVk37bltHxD1rDPwtNM8Q' : 'en-US-BrianMultilingualNeural',  // Kurzgesagt — explainer
//   'UCBJycsmduvYEL83R_U4JriQ' : 'en-US-ChristopherNeural',        // MKBHD — authoritative
const VOICE_BY_CHANNEL = {
  // populate as channels are added
};

function voiceForChannel(channelId) {
  if (process.env.EDGE_TTS_VOICE) return process.env.EDGE_TTS_VOICE;
  return VOICE_BY_CHANNEL[channelId] || DEFAULT_VOICE;
}

module.exports = { voiceForChannel, VOICE_BY_CHANNEL, DEFAULT_VOICE };
