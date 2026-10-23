// Processing / skilling methods. Item names must match the OSRS Wiki names exactly;
// they are resolved to IDs from the live /mapping data at startup.
// perHour = realistic actions per hour for a focused player (including banking).
// fee = coins paid per action to an NPC (sawmill, tanner).
const RECIPES = (() => {
  const R = [];
  const add = (r) => R.push({ fee: 0, notes: '', ...r });

  // --- Herblore ---
  const herbs = [
    ['Guam leaf', 3, 3, 'Guam'], ['Marrentill', 5, 5], ['Tarromin', 11, 12], ['Harralander', 20, 22],
    ['Ranarr weed', 25, 30, 'Ranarr'], ['Toadflax', 30, 34], ['Irit leaf', 40, 45, 'Irit'],
    ['Avantoe', 48, 50], ['Kwuarm', 54, 55], ['Snapdragon', 59, 63], ['Cadantine', 65, 66],
    ['Lantadyme', 67, 69], ['Dwarf weed', 70, 72], ['Torstol', 75, 78],
  ];
  for (const [herb, cleanLvl, unfLvl, unfName] of herbs) {
    add({ cat: 'Herblore', name: `Clean grimy ${herb.toLowerCase()}`, skill: 'Herblore', level: cleanLvl,
      in: [[`Grimy ${herb.toLowerCase()}`, 1]], out: [[herb, 1]], perHour: 5000,
      notes: 'Click-intensive but very fast. Great when grimy herbs are cheap.' });
    add({ cat: 'Herblore', name: `${unfName || herb} potion (unf)`, skill: 'Herblore', level: unfLvl,
      in: [[herb, 1], ['Vial of water', 1]], out: [[`${unfName || herb} potion (unf)`, 1]], perHour: 2600,
      notes: 'Mix a clean herb into a vial of water, 14 at a time.' });
  }
  const pots = [
    ['Prayer potion(3)', 38, 'Ranarr potion (unf)', 'Snape grass'],
    ['Super attack(3)', 45, 'Irit potion (unf)', 'Eye of newt'],
    ['Super energy(3)', 52, 'Avantoe potion (unf)', 'Mort myre fungus'],
    ['Super strength(3)', 55, 'Kwuarm potion (unf)', 'Limpwurt root'],
    ['Super restore(3)', 63, 'Snapdragon potion (unf)', "Red spiders' eggs"],
    ['Super defence(3)', 66, 'Cadantine potion (unf)', 'White berries'],
    ['Antifire potion(3)', 69, 'Lantadyme potion (unf)', 'Dragon scale dust'],
    ['Ranging potion(3)', 72, 'Dwarf weed potion (unf)', 'Wine of zamorak'],
    ['Magic potion(3)', 76, 'Lantadyme potion (unf)', 'Potato cactus'],
    ['Zamorak brew(3)', 78, 'Torstol potion (unf)', 'Jangerberries'],
    ['Saradomin brew(3)', 81, 'Toadflax potion (unf)', 'Crushed nest'],
  ];
  for (const [out, lvl, unf, sec] of pots) {
    add({ cat: 'Herblore', name: out.replace('(3)', ''), skill: 'Herblore', level: lvl,
      in: [[unf, 1], [sec, 1]], out: [[out, 1]], perHour: 2500, notes: 'Add the secondary to an unfinished potion.' });
  }

  // --- Cooking (assumes no burns; low levels will burn some) ---
  const fish = [
    ['Raw tuna', 'Tuna', 30], ['Raw karambwan', 'Cooked karambwan', 30], ['Raw lobster', 'Lobster', 40],
    ['Raw swordfish', 'Swordfish', 45], ['Raw monkfish', 'Monkfish', 62], ['Raw shark', 'Shark', 80],
    ['Raw sea turtle', 'Sea turtle', 82], ['Raw anglerfish', 'Anglerfish', 84],
    ['Raw dark crab', 'Dark crab', 90], ['Raw manta ray', 'Manta ray', 91],
  ];
  for (const [raw, cooked, lvl] of fish) {
    add({ cat: 'Cooking', name: `Cook ${cooked.toLowerCase()}`, skill: 'Cooking', level: lvl,
      in: [[raw, 1]], out: [[cooked, 1]], perHour: 1300,
      notes: 'Profit assumes no burns. Cook 10+ levels above the requirement (or wear cooking gauntlets) to burn less.' });
  }

  // --- Fletching ---
  for (const [log, bow, lvl] of [['Maple logs', 'Maple longbow', 55], ['Yew logs', 'Yew longbow', 70], ['Magic logs', 'Magic longbow', 85]]) {
    add({ cat: 'Fletching', name: `Cut ${bow.toLowerCase()} (u)`, skill: 'Fletching', level: lvl,
      in: [[log, 1]], out: [[`${bow} (u)`, 1]], perHour: 1650, notes: 'Knife + logs.' });
    add({ cat: 'Fletching', name: `String ${bow.toLowerCase()}`, skill: 'Fletching', level: lvl,
      in: [[`${bow} (u)`, 1], ['Bow string', 1]], out: [[bow, 1]], perHour: 2400, notes: '14 at a time, very fast.' });
  }
  for (const [tip, dart, lvl] of [['Mithril dart tip', 'Mithril dart', 52], ['Adamant dart tip', 'Adamant dart', 67], ['Rune dart tip', 'Rune dart', 81], ['Amethyst dart tip', 'Amethyst dart', 90], ['Dragon dart tip', 'Dragon dart', 95]]) {
    add({ cat: 'Fletching', name: `Fletch ${dart.toLowerCase()}s`, skill: 'Fletching', level: lvl,
      in: [[tip, 10], ['Feather', 10]], out: [[dart, 10]], perHour: 1800, notes: '10 darts per action. Huge XP/hr; usually limited by buy limits.' });
  }
  for (const [tips, arrow, lvl] of [['Adamant arrowtips', 'Adamant arrow', 60], ['Rune arrowtips', 'Rune arrow', 75], ['Amethyst arrowtips', 'Amethyst arrow', 82], ['Dragon arrowtips', 'Dragon arrow', 90]]) {
    add({ cat: 'Fletching', name: `Fletch ${arrow.toLowerCase()}s`, skill: 'Fletching', level: lvl,
      in: [[tips, 15], ['Headless arrow', 15]], out: [[arrow, 15]], perHour: 900, notes: '15 arrows per action.' });
  }
  add({ cat: 'Fletching', name: 'Headless arrows', skill: 'Fletching', level: 1,
    in: [['Arrow shaft', 15], ['Feather', 15]], out: [['Headless arrow', 15]], perHour: 900, notes: '15 per action.' });
  for (const [unf, bolt, lvl] of [['Adamant bolts(unf)', 'Adamant bolts', 61], ['Runite bolts (unf)', 'Runite bolts', 69]]) {
    add({ cat: 'Fletching', name: `Feather ${bolt.toLowerCase()}`, skill: 'Fletching', level: lvl,
      in: [[unf, 10], ['Feather', 10]], out: [[bolt, 10]], perHour: 1800, notes: '10 bolts per action.' });
  }
  for (const [gem, tips, lvl] of [['Ruby', 'Ruby bolt tips', 63], ['Diamond', 'Diamond bolt tips', 65], ['Dragonstone', 'Dragonstone bolt tips', 71], ['Onyx', 'Onyx bolt tips', 73]]) {
    add({ cat: 'Fletching', name: `Cut ${tips.toLowerCase()}`, skill: 'Fletching', level: lvl,
      in: [[gem, 1]], out: [[tips, 12]], perHour: 1400, notes: 'Chisel a cut gem into 12 bolt tips.' });
  }

  // --- Crafting ---
  for (const [gem, lvl] of [['Sapphire', 20], ['Emerald', 27], ['Ruby', 34], ['Diamond', 43], ['Dragonstone', 55], ['Onyx', 67], ['Zenyte', 89]]) {
    add({ cat: 'Crafting', name: `Cut ${gem.toLowerCase()}`, skill: 'Crafting', level: lvl,
      in: [[`Uncut ${gem.toLowerCase()}`, 1]], out: [[gem, 1]], perHour: 2700, notes: 'Chisel + uncut gems.' });
  }
  for (const [orb, staff, lvl] of [['Water orb', 'Water battlestaff', 54], ['Earth orb', 'Earth battlestaff', 58], ['Fire orb', 'Fire battlestaff', 62], ['Air orb', 'Air battlestaff', 66]]) {
    add({ cat: 'Crafting', name: `Make ${staff.toLowerCase()}`, skill: 'Crafting', level: lvl,
      in: [['Battlestaff', 1], [orb, 1]], out: [[staff, 1]], perHour: 2500, notes: '14 at a time.' });
  }
  const hides = [['Green', 57, 60, 63], ['Blue', 66, 68, 71], ['Red', 73, 75, 77], ['Black', 79, 82, 84]];
  for (const [c, vLvl, chLvl, bLvl] of hides) {
    const leather = `${c} dragon leather`;
    add({ cat: 'Crafting', name: `${c} d'hide vambraces`, skill: 'Crafting', level: vLvl,
      in: [[leather, 1]], out: [[`${c} d'hide vambraces`, 1]], perHour: 1700, notes: 'Needle + thread (thread cost ignored).' });
    add({ cat: 'Crafting', name: `${c} d'hide chaps`, skill: 'Crafting', level: chLvl,
      in: [[leather, 2]], out: [[`${c} d'hide chaps`, 1]], perHour: 1700, notes: 'Needle + thread.' });
    add({ cat: 'Crafting', name: `${c} d'hide body`, skill: 'Crafting', level: bLvl,
      in: [[leather, 3]], out: [[`${c} d'hide body`, 1]], perHour: 1700, notes: 'Needle + thread.' });
    add({ cat: 'No skill needed', name: `Tan ${c.toLowerCase()} dragonhide`, skill: null, level: 0,
      in: [[`${c} dragonhide`, 1]], out: [[leather, 1]], fee: 20, perHour: 2500,
      notes: 'Pay a tanner 20gp each (Al Kharid / Crafting Guild).' });
  }
  add({ cat: 'Crafting', name: 'Blow unpowered orbs', skill: 'Crafting', level: 46,
    in: [['Molten glass', 1]], out: [['Unpowered orb', 1]], perHour: 1600, notes: 'Glassblowing pipe needed.' });
  add({ cat: 'Crafting', name: 'Blow lantern lenses', skill: 'Crafting', level: 49,
    in: [['Molten glass', 1]], out: [['Lantern lens', 1]], perHour: 1600, notes: 'Glassblowing pipe needed.' });

  // --- Sawmill (coins fee) ---
  for (const [log, plank, fee] of [['Logs', 'Plank', 100], ['Oak logs', 'Oak plank', 250], ['Teak logs', 'Teak plank', 500], ['Mahogany logs', 'Mahogany plank', 1500]]) {
    add({ cat: 'No skill needed', name: `Sawmill ${plank.toLowerCase()}s`, skill: null, level: 0,
      in: [[log, 1]], out: [[plank, 1]], fee, perHour: 2000, notes: `Sawmill operator charges ${fee}gp each (Varrock / Woodcutting Guild).` });
  }

  // --- Smithing ---
  for (const [bar, tip, lvl] of [['Mithril bar', 'Mithril dart tip', 54], ['Adamantite bar', 'Adamant dart tip', 74], ['Runite bar', 'Rune dart tip', 89]]) {
    add({ cat: 'Smithing', name: `Smith ${tip.toLowerCase()}s`, skill: 'Smithing', level: lvl,
      in: [[bar, 1]], out: [[tip, 10]], perHour: 1300, notes: 'Hammer + anvil. 10 tips per bar.' });
  }
  add({ cat: 'Smithing', name: 'Cannonballs', skill: 'Smithing', level: 35,
    in: [['Steel bar', 1]], out: [['Steel cannonball', 4]], perHour: 1100, notes: 'Needs the Dwarf Cannon quest. AFK. A double ammo mould is ~2x faster.' });
  for (const [bar, body, lvl] of [['Mithril bar', 'Mithril platebody', 68], ['Adamantite bar', 'Adamant platebody', 88], ['Runite bar', 'Rune platebody', 99]]) {
    add({ cat: 'Smithing', name: `Smith ${body.toLowerCase()}`, skill: 'Smithing', level: lvl,
      in: [[bar, 5]], out: [[body, 1]], perHour: 330, notes: '5 bars each.' });
  }

  // --- Magic: enchant bolts (assumes an elemental staff covers the elemental runes) ---
  const ench = [
    ['Sapphire bolts', 'Sapphire bolts (e)', 7, [['Cosmic rune', 1], ['Mind rune', 1]]],
    ['Ruby bolts', 'Ruby bolts (e)', 49, [['Cosmic rune', 1], ['Blood rune', 1]]],
    ['Diamond bolts', 'Diamond bolts (e)', 57, [['Cosmic rune', 1], ['Law rune', 2]]],
    ['Dragonstone bolts', 'Dragonstone bolts (e)', 68, [['Cosmic rune', 1], ['Soul rune', 1]]],
    ['Onyx bolts', 'Onyx bolts (e)', 87, [['Cosmic rune', 1], ['Death rune', 1]]],
  ];
  for (const [b, e, lvl, runes] of ench) {
    add({ cat: 'Magic', name: `Enchant ${b.toLowerCase()}`, skill: 'Magic', level: lvl,
      in: [[b, 10], ...runes], out: [[e, 10]], perHour: 1000, notes: 'Uses an elemental staff for the elemental runes. 10 bolts per cast.' });
  }

  return R;
})();
