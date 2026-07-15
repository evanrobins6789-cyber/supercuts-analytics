// One-time input: District Leader / Area Supervisor roster from Book5.xlsx.
// Matched to stores by store CODE (not name), since the same store can be
// labeled slightly differently between reports (e.g. "King of Prussia" here
// vs "KOP" in this file, or "Broadcasting" vs "Broadcasting Sq") — the code
// itself (e.g. 80108) is what's actually reliable across both files.
// Update this list and redeploy if leadership or store assignments change.

export const LEADER_ROSTER_SECTIONS = [
  {
    role: "District Leaders",
    leaders: [
      { name: "Amber Vines", storeCodes: ["80591", "81142", "80618", "80694"] },
      { name: "Andrea Solomon", storeCodes: ["80095", "80952", "81038", "81772"] },
      { name: "Katie Ingram", storeCodes: ["82025", "82267", "80212"] },
      { name: "Laura Kenney", storeCodes: ["81516", "82183", "80180", "80014", "81098"] },
      { name: "Lia Koutsikos", storeCodes: ["80577", "82993", "80651", "8150"] },
      { name: "Lisa Hair", storeCodes: ["80948", "80147", "81673", "82818", "80667", "80719"] },
      { name: "Nicole Klink", storeCodes: ["80554", "80756", "8900", "80711"] },
    ],
  },
  {
    role: "Area Supervisors",
    leaders: [
      { name: "Allie Clifford", storeCodes: ["82734", "80108", "81475", "8844"] },
      { name: "Brandy DiGiacomo", storeCodes: ["81416", "89080", "82262"] },
      { name: "Christina Nole", storeCodes: ["80185", "82179"] },
      { name: "Erik Petner", storeCodes: ["80661", "81092", "8919"] },
      { name: "Jennifer Sutton", storeCodes: ["81729", "80684", "80354", "80358"] },
      { name: "Julie Beauzier", storeCodes: ["80306", "80873", "82831"] },
      { name: "Kate Phillips", storeCodes: ["82223", "82264"] },
      { name: "Katie Stout", storeCodes: ["81795", "81219", "81036"] },
      { name: "Laura Guth (GF)", storeCodes: ["80417", "8961"] },
      { name: "LouAnne Costanzo (GF)", storeCodes: ["80793", "82817", "82265"] },
    ],
  },
];

const storeCodeToLeader = {};
LEADER_ROSTER_SECTIONS.forEach(sec => {
  sec.leaders.forEach(l => {
    l.storeCodes.forEach(code => {
      storeCodeToLeader[code] = { leaderName: l.name, role: sec.role };
    });
  });
});

export function getLeaderForStoreCode(code) {
  return code != null ? storeCodeToLeader[String(code)] || null : null;
}
