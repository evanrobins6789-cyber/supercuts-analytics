import backTurned from './assets/bitmoji/back-turned.png';
import peekHalfFace from './assets/bitmoji/peek-half-face.png';
import skepticalLook from './assets/bitmoji/skeptical-look.png';
import thumbsUp from './assets/bitmoji/thumbs-up.png';
import jumpingCelebrate from './assets/bitmoji/jumping-celebrate.png';
import heartHands from './assets/bitmoji/heart-hands.png';
import laughingSnap from './assets/bitmoji/laughing-snap.png';
import thinkingChin from './assets/bitmoji/thinking-chin.png';
import teamAwesome from './assets/bitmoji/team-awesome.png';
import fingersCrossed from './assets/bitmoji/fingers-crossed.png';
import unimpressed from './assets/bitmoji/unimpressed.png';
import lyingDownTired from './assets/bitmoji/lying-down-tired.png';
import jailPointing from './assets/bitmoji/jail-pointing.png';

// Curated by mood so a peek spot near "good news" (top performer, 5-star
// review) pulls from a different pool than one near neutral/browsing UI.
export const BITMOJI_POOLS = {
  positive: [thumbsUp, jumpingCelebrate, heartHands, laughingSnap, teamAwesome],
  curious: [peekHalfFace, thinkingChin, fingersCrossed, backTurned],
  skeptical: [skepticalLook, unimpressed, jailPointing, lyingDownTired],
  all: [
    backTurned, peekHalfFace, skepticalLook, thumbsUp, jumpingCelebrate, heartHands,
    laughingSnap, thinkingChin, teamAwesome, fingersCrossed, unimpressed, lyingDownTired, jailPointing,
  ],
};
