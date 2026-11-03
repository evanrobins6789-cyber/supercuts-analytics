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

// Plain-language coaching (2026-11-03, reworded at the user's ask): concrete
// counts ("2 more products at about $25 each") and what that does to TSTH
// and pay, per hour and by the end of the pay period, instead of $/hr gaps.
// `periodFactor` scales a so-far amount to the whole pay period at the
// same pace (1 when the dates shown are already a full period).
const money = v => `$${Math.round(v).toLocaleString('en-US')}`;
const money2 = v => `$${(v || 0).toFixed(2)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const avgPrice = (amount, qty, fallback) => (qty > 0 && amount > 0 ? amount / qty : fallback);
const cap = s => `${s[0].toUpperCase()}${s.slice(1)}`;

// One sentence on what the extra sales would do to TSTH and pay.
function impactSentence(pay, im, periodFactor) {
  const tsthPart = `your TSTH would go from ${money2(pay.tsth)} to ${money2(im.newTsth)}`;
  if (im.bonusUp > 0.5) {
    const perHr = im.bonusUp / pay.hours;
    const byEnd = im.bonusUp * periodFactor;
    const lead = im.reachesGoal ? `That puts you over the $${pay.goal} goal: ${tsthPart}` : cap(tsthPart);
    return `${lead}, which adds ${money2(perHr)} per hour in bonus, about ${money(byEnd)} more ${periodFactor > 1.01 ? 'by the end of the pay period at your current pace' : 'for these dates'}.`;
  }
  const still = pay.goal - im.newTsth;
  return `${cap(tsthPart)}, ${money2(im.tsthUp)} closer to the $${pay.goal} goal${still > 0 ? ` (then ${money2(still)} to go)` : ''}.`;
}

export function buildCoaching({ stores, pay, peers, periodFactor = 1 }) {
  if (!pay) return [];
  const company = peers?.company || {};
  const out = [];
  const home = [...(stores || [])].sort((a, b) => b.hours - a.hours)[0];
  const homePeers = home && peers?.stores?.[home.code];
  const productPrice = avgPrice(homePeers?.productAmount, homePeers?.productQty, avgPrice(company.productAmount, company.productQty, 20));
  const colorPrice = avgPrice(homePeers?.colorAmount, homePeers?.colorTickets, avgPrice(company.colorAmount, company.colorTickets, 60));
  const cutTicket = home && home.haircuts > 0 ? (home.sales - home.retail - home.colorSales) / home.haircuts : 25;

  if (pay.tsth < pay.goal) {
    const need = (pay.goal - pay.tsth) * pay.hours;
    const nProducts = Math.ceil(need / productPrice);
    const nColor = Math.ceil(need / colorPrice);
    const nCuts = Math.ceil(need / cutTicket);
    out.push({
      key: 'goal', kind: 'goal',
      title: `${money(need)} more in sales starts your bonus`,
      detail: `Your TSTH is ${money2(pay.tsth)} and the goal is $${pay.goal}. Over the ${pay.hours.toFixed(1)} hours you've worked, ${money(need)} more in sales gets you there. That's about ${plural(nProducts, 'product')} (about ${money(productPrice)} each), or ${plural(nColor, 'color service')} (about ${money(colorPrice)} each), or ${plural(nCuts, 'more haircut')} (about ${money(cutTicket)} each), or a mix. After that, every extra $1 of TSTH pays you $${pay.bonusRate.toFixed(2)} more per hour on every hour you work.`,
    });
  } else {
    out.push({
      key: 'goal', kind: 'good',
      title: `You're bonusing: ${money2(pay.aboveGoal)} over the $${pay.goal} goal`,
      detail: `That's ${money2(pay.bonusPerHour)} per hour in bonus, ${money(pay.bonus)} so far${periodFactor > 1.01 ? ` and about ${money(pay.bonus * periodFactor)} by the end of the pay period at this pace` : ''}. Each extra product you sell (about ${money(productPrice)}) adds about ${money2((productPrice / pay.hours) * pay.bonusRate)} per hour to your bonus.`,
    });
  }

  const ideas = [];
  (stores || []).filter(s => s.hours >= MIN_STORE_HOURS).forEach(s => {
    const local = peers?.stores?.[s.code];
    const useLocal = local && local.people >= MIN_PEERS && local.hours > 0;
    const ref = useLocal ? local : company;
    if (!ref || !(ref.hours > 0)) return;
    const others = useLocal ? `the other ${local.people} stylists at ${s.name}` : 'stylists across the company';
    const Others = cap(others);
    const at = stores.length > 1 ? ` at ${s.name}` : '';
    const pPrice = avgPrice(local?.productAmount, local?.productQty, productPrice);
    const cPrice = avgPrice(local?.colorAmount, local?.colorTickets, colorPrice);
    const push = (key, title, story, extra) => {
      if (!(extra > 1)) return;
      const im = impactOf(pay, extra);
      ideas.push({ key: `${key}-${s.code}`, kind: 'idea', title, detail: `${story} ${impactSentence(pay, im, periodFactor)}`, ...im });
    };

    // Product
    const refRetailPerHr = ref.retail / ref.hours;
    if (refRetailPerHr > 0 && s.retail / s.hours < refRetailPerHr * 0.8) {
      const n = Math.max(1, Math.round((refRetailPerHr * s.hours - s.retail) / pPrice));
      const extra = n * pPrice;
      const perShift = (refRetailPerHr * 8) / pPrice;
      const rateText = perShift >= 0.95
        ? `about ${perShift.toFixed(1)} products per 8-hour shift`
        : `about 1 product every ${Math.max(2, Math.round(1 / perShift))} shifts`;
      const noneButOthers = s.retail === 0 && useLocal && local.withRetail / local.people >= 0.5;
      push('retail',
        noneButOthers ? `Sell product${at}: ${local.withRetail} of ${local.people} others there do` : `Sell a little more product${at}`,
        `${s.retail === 0 ? 'You haven’t sold any product yet' : `You’ve sold ${money(s.retail)} in product`}${at}. ${Others} sell ${rateText} (about ${money(pPrice)} each). Selling ${plural(n, 'more product')} (${money(extra)}) would match them.`,
        extra);
    }
    // Color
    const refColorPerHr = ref.colorSales / ref.hours;
    if (refColorPerHr > 0 && s.colorSales / s.hours < refColorPerHr * 0.8) {
      const n = Math.max(1, Math.round((refColorPerHr * s.hours - s.colorSales) / cPrice));
      const extra = n * cPrice;
      const noneButOthers = s.colorSales === 0 && useLocal && local.withColor / local.people >= 0.5;
      push('color',
        noneButOthers ? `Offer color${at}: ${local.withColor} of ${local.people} others there do it` : `Book a bit more color${at}`,
        `${s.colorSales === 0 ? 'You haven’t done any color yet' : `You’ve done ${money(s.colorSales)} in color`}${at}, while ${others} average ${money(refColorPerHr * 8)} in color per 8-hour shift. ${cap(plural(n, 'more color service'))} (${n === 1 ? `about ${money(cPrice)}` : `about ${money(cPrice)} each, ${money(extra)} total`}) would match them.`,
        extra);
    }
    if (s.haircuts > 0 && ref.haircuts > 0) {
      // Extras on a haircut (shampoo, beard trim, wax, treatments)
      const myAdd = (s.otherServices || 0) / s.haircuts;
      const refAdd = (ref.otherServices || 0) / ref.haircuts;
      if (refAdd > 0 && myAdd < refAdd * 0.8) {
        const extra = (refAdd - myAdd) * s.haircuts;
        push('addons', `Add more extras to your haircuts${at}`,
          `${Others} add about ${money2(refAdd)} in extras (shampoo, beard trim, wax, treatments) to the average haircut; you add ${money2(myAdd)}. Across your ${plural(s.haircuts, 'haircut')}${at} that's ${money(extra)}, for example a shampoo or beard trim on a few more of them.`,
          extra);
      }
      // Haircuts per shift
      const myCph = s.haircuts / s.hours;
      const refCph = ref.haircuts / ref.hours;
      if (myCph < refCph * 0.85) {
        const n = Math.max(1, Math.round((refCph - myCph) * s.hours));
        const ticket = (s.sales - s.retail) / s.haircuts;
        push('cph', `Fit in a few more haircuts${at}`,
          `${Others} average ${(refCph * 8).toFixed(1)} haircuts per 8-hour shift; you average ${(myCph * 8).toFixed(1)}. ${cap(plural(n, 'more haircut'))} over your hours${at} (about ${money(ticket)} each with your usual services) is ${money(n * ticket)}.`,
          n * ticket);
      }
    }
  });
  ideas.sort((a, b) => b.extraSales - a.extraSales);
  return [...out, ...ideas];
}
