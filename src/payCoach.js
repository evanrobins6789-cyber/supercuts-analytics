// My Numbers pay breakdown + coaching (2026-11-03).
//
// Pay rules are the user's (see src/payTracker.js): TSTH = total sales
// (service + color + retail) ÷ hours; goal = 2 × haircut price (PA $28, NJ/DE
// $30) at the store where they worked the most hours; bonus/hr = (TSTH − goal)
// × 25% (30% management), only above goal, on every hour; no other commission.
// Guaranteed = base (rate × hours) + tips. Possible = guaranteed + bonus (the
// bonus is paid if they finish the pay period).
//
// Coaching compares a person with everyone ELSE at the same store over the
// same dates (aggregates from buildPeerStats, never names), or company-wide
// when fewer than MIN_PEERS others worked there, and turns each gap into
// "this much more in sales, this much more bonus".
import { haircutPriceFor, storeState, BONUS_RATE } from './payTracker';

export const MIN_PEERS = 3;
const MIN_STORE_HOURS = 4;

const bonusFor = (sales, hours, goal, rate) => (hours > 0 ? Math.max(0, (sales / hours - goal) * rate) * hours : 0);

export function buildPayBreakdown({ stores, total, payRate = null, manager = false }) {
  if (!total || !(total.hours > 0) || !stores?.length) return null;
  const home = [...stores].sort((a, b) => b.hours - a.hours)[0];
  const price = haircutPriceFor(home.code);
  const goal = price * 2;
  const bonusRate = manager ? BONUS_RATE.management : BONUS_RATE.stylist;
  const hours = total.hours;
  const tsth = total.sales / hours;
  const bonusPerHour = tsth > goal ? (tsth - goal) * bonusRate : 0;
  const bonus = bonusPerHour * hours;
  const base = payRate != null ? payRate * hours : null;
  const tips = total.tips || 0;
  const guaranteed = base != null ? base + tips : null;
  const possible = guaranteed != null ? guaranteed + bonus : null;
  return {
    homeStore: home.name, state: storeState(home.code), price, goal, bonusRate, manager,
    hours, sales: total.sales, tsth, aboveGoal: tsth - goal, bonusPerHour, bonus,
    payRate, base, tips, tipsPerHour: tips / hours,
    guaranteed, guaranteedPerHour: guaranteed != null ? guaranteed / hours : null,
    possible, possiblePerHour: possible != null ? possible / hours : null,
  };
}

// What `extraSales` more in sales over the period would do to their pay.
function impactOf(pay, extraSales) {
  const newBonus = bonusFor(pay.sales + extraSales, pay.hours, pay.goal, pay.bonusRate);
  const newTsth = (pay.sales + extraSales) / pay.hours;
  return { extraSales, tsthUp: extraSales / pay.hours, newTsth, bonusUp: newBonus - pay.bonus, reachesGoal: pay.tsth < pay.goal && newTsth >= pay.goal };
}

export function buildCoaching({ stores, pay, peers }) {
  if (!pay) return [];
  const tips = [];
  if (pay.tsth < pay.goal) {
    const perHr = pay.goal - pay.tsth;
    tips.push({
      key: 'goal', kind: 'goal',
      title: `You're $${perHr.toFixed(2)}/hr in sales below the $${pay.goal} TSTH goal`,
      detail: `To start earning bonus you need about $${Math.round(perHr * pay.hours)} more in sales over your ${pay.hours.toFixed(1)} hours (about $${Math.round(perHr * 8)} per 8-hour shift). Once you're over $${pay.goal}, every $1/hr above it pays $${pay.bonusRate.toFixed(2)}/hr in bonus on every hour you work.`,
    });
  } else {
    tips.push({
      key: 'goal', kind: 'good',
      title: `You're $${pay.aboveGoal.toFixed(2)}/hr above the $${pay.goal} TSTH goal`,
      detail: `That's earning you $${pay.bonusPerHour.toFixed(2)}/hr in bonus. Every extra $10/hr in sales adds $${(10 * pay.bonusRate).toFixed(2)}/hr more.`,
    });
  }

  const ideas = [];
  (stores || []).filter(s => s.hours >= MIN_STORE_HOURS).forEach(s => {
    const local = peers?.stores?.[s.code];
    const useLocal = local && local.people >= MIN_PEERS && local.hours > 0;
    const ref = useLocal ? local : peers?.company;
    if (!ref || !(ref.hours > 0)) return;
    const who = useLocal ? `the other ${local.people} stylists at ${s.name}` : 'stylists company-wide';
    const where = (stores.length > 1 ? ` at ${s.name}` : '');
    const add = (key, title, detail, extra) => {
      if (!(extra > 1)) return;
      const im = impactOf(pay, extra);
      ideas.push({ key: `${key}-${s.code}`, kind: 'idea', title, detail, ...im });
    };

    // Product (retail)
    const myRetail = s.retail / s.hours;
    const refRetail = ref.retail / ref.hours;
    if (refRetail > 0 && myRetail < refRetail * 0.8) {
      const extra = (refRetail - myRetail) * s.hours;
      const noneButOthers = s.retail === 0 && useLocal && local.withRetail / local.people >= 0.5;
      add('retail',
        noneButOthers ? `No product sales${where}, but ${local.withRetail} of ${local.people} others there sold product` : `Product sales${where} are below ${who}`,
        `You: $${myRetail.toFixed(2)}/hr in product. ${who[0].toUpperCase()}${who.slice(1)}: $${refRetail.toFixed(2)}/hr. Matching them over your ${s.hours.toFixed(1)} hours there is about $${Math.round(extra)} more in product.`,
        extra);
    }
    // Color
    const myColor = s.colorSales / s.hours;
    const refColor = ref.colorSales / ref.hours;
    if (refColor > 0 && myColor < refColor * 0.8) {
      const extra = (refColor - myColor) * s.hours;
      const noneButOthers = s.colorSales === 0 && useLocal && local.withColor / local.people >= 0.5;
      add('color',
        noneButOthers ? `No color services${where}, but ${local.withColor} of ${local.people} others there did color` : `Color sales${where} are below ${who}`,
        `You: $${myColor.toFixed(2)}/hr in color. ${who[0].toUpperCase()}${who.slice(1)}: $${refColor.toFixed(2)}/hr. Matching them is about $${Math.round(extra)} more in color.`,
        extra);
    }
    // Haircuts per hour (speed / filling the book)
    if (s.haircuts > 0 && ref.haircuts > 0) {
      const myCph = s.haircuts / s.hours;
      const refCph = ref.haircuts / ref.hours;
      if (myCph < refCph * 0.85) {
        const ticket = (s.sales - s.retail) / s.haircuts;
        const extraCuts = (refCph - myCph) * s.hours;
        add('cph', `Fewer haircuts per hour${where} than ${who}`,
          `You: ${myCph.toFixed(2)} cuts/hr. ${who[0].toUpperCase()}${who.slice(1)}: ${refCph.toFixed(2)}. That's about ${Math.round(extraCuts)} more haircuts over your hours, worth about $${Math.round(extraCuts * ticket)} at your average service ticket of $${ticket.toFixed(2)}.`,
          extraCuts * ticket);
      }
      // Service $ per haircut (add-ons: shampoo, beard trim, waxing, treatments)
      const myTicket = (s.sales - s.retail - s.colorSales) / s.haircuts;
      const refTicket = (ref.sales - ref.retail - ref.colorSales) / ref.haircuts;
      if (myTicket < refTicket * 0.9) {
        const extra = (refTicket - myTicket) * s.haircuts;
        add('ticket', `Lower service $ per haircut${where} than ${who}`,
          `You average $${myTicket.toFixed(2)} in services (not counting color or product) per haircut; ${who} average $${refTicket.toFixed(2)}. Adding a shampoo, beard trim, wax or treatment more often would close that: about $${Math.round(extra)} more over your ${s.haircuts} haircuts.`,
          extra);
      }
    }
  });
  ideas.sort((a, b) => b.extraSales - a.extraSales);
  return [...tips, ...ideas];
}
