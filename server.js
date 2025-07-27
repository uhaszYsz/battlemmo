const WebSocket = require('ws');

// ===================================================================================
// --- GAME CONFIGURATION ---
// ===================================================================================
const CONFIG = {
    // General Settings
    MAP_SIZE: 8,
    GAME_TICK: 100, // ms
    MAX_ATTACKERS: 5,

    // Player Settings
    PLAYER_DEFAULT_STATS: { hp: 100, maxHp: 100, dmg: 5, speed: 1, critical: 5, dodge: 5 },
    PLAYER_DEFAULT_INVENTORY: [
        { name: 'Rusty Sword', slot: 'hand', stats: { dmg: 2, speed: 0.1 } },
        { name: 'Leather Tunic', slot: 'chest', stats: { maxHp: 100 } }
    ],

    // Construction Settings
    CONSTRUCTION_BASE_HP: 100,
    CONSTRUCTION_BASE_BRICKS_REQUIRED: 10,
    CONSTRUCTION_TIME_PER_BRICK: 10000, // 10 seconds per brick

    // Siege Machine Settings
    SIEGE_MACHINE_COST: 10, // bricks
    SIEGE_MACHINE_HP: 300,
    SIEGE_MACHINE_DAMAGE: 10, // damage per second
    SIEGE_MACHINE_SELF_DAMAGE: 10, // self-damage per second

    // Enemy Settings
    ENEMY_RESPAWN_TIME: 5000, // 5 seconds
    ENEMY_STAT_SCALING_PER_LEVEL: 0.10, // 10% increase per level

    // --- ENEMY DEFINITIONS ---
    ENEMY_TEMPLATES: [
        { name: 'Goblin', baseStats: { hp: 30, dmg: 3, speed: 0.8 }, weakness: 'hunting', drops: [{ name: 'Brick', chance: 0.80, quantity: [1, 2] }, { name: 'Goblin Ear', chance: 0.25, quantity: [1, 1] }] },
        { name: 'Orc', baseStats: { hp: 80, dmg: 10, speed: 0.5 }, weakness: 'hunting', drops: [{ name: 'Brick', chance: 1.0, quantity: [2, 4] }, { name: 'Orc Tusk', chance: 0.15, quantity: [1, 1] }] },
        { name: 'Slime', baseStats: { hp: 20, dmg: 2, speed: 1.0 }, weakness: 'hunting', drops: [{ name: 'Brick', chance: 1.0, quantity: [20, 20] }, { name: 'Slime Gel', chance: 0.5, quantity: [1, 3] }] },
        { name: 'Rock Golem', baseStats: { hp: 150, dmg: 8, speed: 0.3 }, weakness: 'mining', drops: [{ name: 'Brick', chance: 1.0, quantity: [10, 20] }, { name: 'Iron Ore', chance: 0.5, quantity: [1, 5] }] },
        { name: 'Mining Site', baseStats: { hp: 500, dmg: 0, speed: 0 }, weakness: 'mining', drops: [{ name: 'Iron Ore', chance: 1.0, quantity: [10, 20] }] },
        { name: 'Wood Cutting Site', baseStats: { hp: 500, dmg: 0, speed: 0 }, weakness: 'woodcutting', drops: [{ name: 'Wood', chance: 1.0, quantity: [10, 20] }] }
    ],

    // --- INTERNAL CONSTANTS (DO NOT MODIFY) ---
    ENTITY_TYPES: { MOB: 'mob', PLAYER: 'player', CONSTRUCTION_SITE: 'construction_site', SIEGE_MACHINE: 'siege' },
};

// ===================================================================================
// --- GAME CLASS (CORE LOGIC) ---
// ===================================================================================
class Game {
    constructor(broadcastCallback, sendToClientCallback) {
        this.broadcast = broadcastCallback;
        this.sendToClient = sendToClientCallback;
        this.state = {
            players: [],
            teams: {},
            objects: [],
            world: Array(CONFIG.MAP_SIZE).fill(0).map(() => Array(CONFIG.MAP_SIZE).fill(0).map(() => ({ players: [], objects: [], info: {} }))),
            chatMessages: [],
        };
        this.teamColors = ['blue-600', 'red-600', 'green-500', 'yellow-500', 'purple-600', 'pink-600', 'indigo-500', 'teal-500'];
        this.nextTeamColorIndex = 0;
    }

    init() {
        this.logEvent("Game server started. Waiting for players...");
        this.initializeEnemies();
        this.updateWorldState();
        setInterval(() => this.update(), CONFIG.GAME_TICK);
    }

    initializeEnemies() {
        let enemyCounters = {};
        for (let y = 0; y < CONFIG.MAP_SIZE; y++) {
            for (let x = 0; x < CONFIG.MAP_SIZE; x++) {
                for (let i = 0; i < 9; i++) {
                    const templateId = Math.floor(Math.random() * CONFIG.ENEMY_TEMPLATES.length);
                    const template = CONFIG.ENEMY_TEMPLATES[templateId];
                    if (!template) continue;

                    enemyCounters[template.name] = (enemyCounters[template.name] || 0) + 1;
                    const enemyId = `${template.name.replace(/\s/g, '').toLowerCase()}${enemyCounters[template.name]}`;

                    const newEnemy = {
                        id: enemyId, x, y, level: 1, templateId,
                        baseStats: JSON.parse(JSON.stringify(template.baseStats)),
                        stats: JSON.parse(JSON.stringify(template.baseStats)),
                        weakness: template.weakness, respawnUntil: null,
                        type: CONFIG.ENTITY_TYPES.MOB,
                        attackers: [],
                        maxAttackers: CONFIG.MAX_ATTACKERS,
                        attackCooldown: 0,
                    };
                    this.scaleEnemyStats(newEnemy);
                    this.state.objects.push(newEnemy);
                }
            }
        }
    }

    logEvent(message, targetClient = null) {
        const payload = { type: 'log', message: `[${new Date().toLocaleTimeString()}] ${message}` };
        if (targetClient) {
             targetClient.send(JSON.stringify(payload));
        } else {
            this.broadcast(payload);
        }
        console.log(payload.message);
    }

    logCombat(message) {
        this.broadcast({ type: 'combatLog', message });
        console.log(`[Combat] ${message}`);
    }

    handleChatMessage(playerId, data) {
        const player = this.findPlayerById(playerId);
        if (!player) return;

        const message = {
            channel: data.channel,
            senderId: player.id,
            senderTeam: player.team,
            text: data.text,
            timestamp: new Date().toLocaleTimeString(),
            location: { x: player.x, y: player.y },
            targetId: player.attacking
        };

        this.state.chatMessages.push(message);
        if (this.state.chatMessages.length > 100) this.state.chatMessages.shift();

        this.broadcast({ type: 'chat', message });
    }

    recalculatePlayerStats(player) {
        if (!player) return;
        const currentHp = player.stats.hp;
        const finalStats = { ...player.baseStats };

        for (const slot in player.equipment) {
            const item = player.equipment[slot];
            if (item?.stats) {
                for (const stat in item.stats) {
                    if (finalStats[stat] !== undefined) {
                        finalStats[stat] += item.stats[stat];
                    }
                }
            }
        }

        if (player.skills.hp) {
            const hpMultiplier = 1 + (player.skills.hp.level / 100);
            finalStats.maxHp = Math.floor(finalStats.maxHp * hpMultiplier);
        }

        player.stats = finalStats;
        player.stats.hp = Math.min(currentHp, player.stats.maxHp);
    }

    scaleEnemyStats(enemy) {
        const levelMultiplier = 1 + (enemy.level - 1) * CONFIG.ENEMY_STAT_SCALING_PER_LEVEL;
        enemy.stats.maxHp = Math.floor(enemy.baseStats.hp * levelMultiplier);
        enemy.stats.dmg = Math.floor(enemy.baseStats.dmg * levelMultiplier);
        enemy.stats.speed = enemy.baseStats.speed * levelMultiplier;
        enemy.stats.hp = enemy.stats.maxHp;
        enemy.attackCooldown = (enemy.stats.speed > 0) ? 1000 / enemy.stats.speed : 0;
    }

    createPlayer(client) {
        const newId = `player${this.state.players.length + 1}`;
        const newPlayer = {
            id: newId, x: 0, y: 0, team: null,
            baseStats: JSON.parse(JSON.stringify(CONFIG.PLAYER_DEFAULT_STATS)),
            stats: JSON.parse(JSON.stringify(CONFIG.PLAYER_DEFAULT_STATS)),
            inventory: JSON.parse(JSON.stringify(CONFIG.PLAYER_DEFAULT_INVENTORY)),
            equipment: { hand: null, chest: null },
            attacking: null, attackCooldown: 0,
            isDead: false, type: CONFIG.ENTITY_TYPES.PLAYER,
            skills: { hp: { level: 1, exp: 0 }, heal: { level: 1, exp: 0 }, woodcutting: { level: 1, exp: 0 }, carpentry: { level: 1, exp: 0 }, mining: { level: 1, exp: 0 }, smithing: { level: 1, exp: 0 }, engineering: { level: 1, exp: 0 }, construction: { level: 1, exp: 0 }, hunting: { level: 1, exp: 0 }, battle: { level: 1, exp: 0 } }
        };
        this.state.players.push(newPlayer);
        client.playerId = newId;
        this.logEvent(`A new hero, ${newId}, has joined the realm!`);
        this.sendToClient(client, {type: 'playerCreated', playerId: newId, message: `Welcome! You are ${newId}.`});
        this.updateWorldState();
    }

    createTeam(playerId, teamName) {
        const player = this.findPlayerById(playerId);
        const client = this.getClientByPlayerId(playerId);
        if (!player) return;
        if (!teamName || teamName.length < 3 || teamName.length > 15) {
            this.logEvent("Team name must be between 3 and 15 characters.", client);
            return;
        }
        if (Object.values(this.state.teams).some(t => t.name.toLowerCase() === teamName.toLowerCase())) {
            this.logEvent(`A team named '${teamName}' already exists.`, client);
            return;
        }

        const newTeamId = `team_${Date.now()}`;
        const color = this.teamColors[this.nextTeamColorIndex % this.teamColors.length];
        this.nextTeamColorIndex++;

        this.state.teams[newTeamId] = { 
            id: newTeamId, 
            name: teamName, 
            members: [], 
            color: color,
            adminId: playerId,
            description: '',
            joinPolicy: 'open',
            requests: []
        };
        this.logEvent(`Team '${teamName}' has been founded by ${playerId}!`);
        this.joinTeam(playerId, newTeamId);
    }

    joinTeam(playerId, teamId, isForced = false) {
        const player = this.findPlayerById(playerId);
        const team = this.state.teams[teamId];
        const client = this.getClientByPlayerId(playerId);
        if (!player || !team) {
            this.logEvent("Player or Team not found.", client);
            return;
        }
        
        if (team.joinPolicy === 'request' && !isForced) {
            this.logEvent(`This team requires a request to join.`, client);
            return;
        }

        if (player.team) {
            this.leaveTeam(playerId, true); // Leave current team silently before joining new one
        }

        player.team = teamId;
        team.members.push(playerId);
        this.logEvent(`${playerId} has joined team '${team.name}'.`);
        this.updateWorldState();
    }

    leaveTeam(playerId, isSilent = false) {
        const player = this.findPlayerById(playerId);
        if (!player || !player.team) {
            if (!isSilent) this.logEvent("You are not in a team.", this.getClientByPlayerId(playerId));
            return;
        }

        const team = this.state.teams[player.team];
        if (team) {
            team.members = team.members.filter(id => id !== playerId);
            if (!isSilent) this.logEvent(`${playerId} has left team '${team.name}'.`);

            if (team.members.length === 0) {
                delete this.state.teams[player.team];
                this.logEvent(`Team '${team.name}' has been disbanded.`);
            } else if (team.adminId === playerId) {
                team.adminId = team.members[0]; // Assign new admin
                this.logEvent(`${team.adminId} is now the admin of team '${team.name}'.`);
            }
        }

        player.team = null;
        if (!isSilent) this.updateWorldState();
    }

    updateTeamSettings(adminId, data) {
        const team = this.state.teams[data.teamId];
        const client = this.getClientByPlayerId(adminId);
        if (!team) {
            this.logEvent("Team not found.", client);
            return;
        }
        if (team.adminId !== adminId) {
            this.logEvent("You are not the admin of this team.", client);
            return;
        }
        
        team.description = data.description.slice(0, 100);
        team.joinPolicy = data.joinPolicy === 'request' ? 'request' : 'open';
        
        this.logEvent(`Team '${team.name}' settings have been updated.`, client);
        this.updateWorldState();
    }

    requestToJoin(playerId, teamId) {
        const team = this.state.teams[teamId];
        const client = this.getClientByPlayerId(playerId);
        if (!team) {
            this.logEvent("Team not found.", client);
            return;
        }
        if (team.requests.includes(playerId) || team.members.includes(playerId)) {
            this.logEvent("You have already sent a request or are a member.", client);
            return;
        }
        
        team.requests.push(playerId);
        this.logEvent(`Your request to join '${team.name}' has been sent.`, client);
        this.updateWorldState();
    }

    resolveJoinRequest(adminId, data) {
        const { teamId, requesterId, decision } = data;
        const team = this.state.teams[teamId];
        const adminClient = this.getClientByPlayerId(adminId);
        if (!team) {
            this.logEvent("Team not found.", adminClient);
            return;
        }
        if (team.adminId !== adminId) {
            this.logEvent("You are not the admin of this team.", adminClient);
            return;
        }
        
        team.requests = team.requests.filter(id => id !== requesterId);
        
        const requesterClient = this.getClientByPlayerId(requesterId);
        if (decision === 'accept') {
            this.logEvent(`Your request to join '${team.name}' was accepted.`, requesterClient);
            this.joinTeam(requesterId, teamId, true);
        } else {
            this.logEvent(`Your request to join '${team.name}' was declined.`, requesterClient);
            this.updateWorldState();
        }
    }

    respawnPlayer(playerId) {
        const player = this.findPlayerById(playerId);
        if (player && player.isDead) {
            player.isDead = false;
            player.stats.hp = player.stats.maxHp;
            player.x = 0;
            player.y = 0;
            this.logEvent(`${player.id} has respawned!`);
            this.updateWorldState();
        }
    }

    findPlayerById = (playerId) => this.state.players.find(p => p.id === playerId);

    movePlayer(playerId, x, y) {
        const player = this.findPlayerById(playerId);
        if (!player || player.isDead) return;
        if (x < 0 || y < 0 || x >= CONFIG.MAP_SIZE || y >= CONFIG.MAP_SIZE) {
            this.logEvent("Cannot move outside the map boundaries.", this.getClientByPlayerId(playerId));
            return;
        }
        this.stopCombat(player);
        this.logEvent(`${player.id} moved to (${x}, ${y}).`);
        player.x = x;
        player.y = y;
        this.updateWorldState();
    }

    startCombat(playerId, targetId) {
        const player = this.findPlayerById(playerId);
        const client = this.getClientByPlayerId(playerId);
        if (!player || player.isDead) return;

        const target = this.findEntityById(targetId);
        if (!target || target.x !== player.x || target.y !== player.y) {
            this.logEvent("Target not found in the current area.", client);
            return;
        }

        if (target.respawnUntil) {
            this.logEvent("You can't attack a respawning enemy.", client);
            return;
        }

        if (target.type === CONFIG.ENTITY_TYPES.PLAYER) {
            this.stopCombat(player);
            player.attacking = targetId;
            player.attackCooldown = 1000 / player.stats.speed;
            this.logEvent(`${player.id} started attacking ${target.id}.`);
            this.updateWorldState();
            return;
        }

        if (player.attacking === targetId) return;

        if (target.attackers.length >= target.maxAttackers && !target.attackers.includes(player.id)) {
            this.logEvent(`${target.id} is already being fully engaged!`, client);
            return;
        }

        this.stopCombat(player);

        if (!target.attackers.includes(player.id)) {
            target.attackers.push(player.id);
        }

        player.attacking = targetId;
        player.attackCooldown = 1000 / player.stats.speed;
        this.logEvent(`${player.id} joined the attack on ${target.id}.`);

        this.updateWorldState();
    }

    equipItem(playerId, itemIndex) {
        const player = this.findPlayerById(playerId);
        if (!player) return;
        const item = player.inventory[itemIndex];
        if (!item || !item.slot) return;

        if (player.equipment[item.slot]) {
            player.inventory.push(player.equipment[item.slot]);
        }

        player.equipment[item.slot] = item;
        player.inventory.splice(itemIndex, 1);
        this.logEvent(`${player.id} equipped ${item.name}.`);
        this.recalculatePlayerStats(player);
        this.updateWorldState();
    }

    unequipItem(playerId, slot) {
        const player = this.findPlayerById(playerId);
        if (!player) return;
        const item = player.equipment[slot];
        if (!item) return;

        player.inventory.push(item);
        player.equipment[slot] = null;
        this.logEvent(`${player.id} unequipped ${item.name}.`);
        this.recalculatePlayerStats(player);
        this.updateWorldState();
    }

    stopCombat(player) {
        if (!player.attacking) return;
        const oldTarget = this.findEntityById(player.attacking);

        player.attacking = null;

        if (oldTarget && oldTarget.attackers) {
            const playerIndex = oldTarget.attackers.indexOf(player.id);
            if (playerIndex > -1) {
                oldTarget.attackers.splice(playerIndex, 1);
            }
        }
    }

    buildConstructionSite(playerId) {
        const player = this.findPlayerById(playerId);
        if (!player || player.isDead || !player.team) {
            this.logEvent("You must be in a team to build.", this.getClientByPlayerId(playerId));
            return;
        }
        const { x, y } = player;
        if(this.state.world[y][x].objects.some(o => o.type === CONFIG.ENTITY_TYPES.CONSTRUCTION_SITE)) {
            this.logEvent("A construction site already exists here.", this.getClientByPlayerId(playerId));
            return;
        }
        const siteId = `site_t${player.team}_${x}_${y}`;
        this.state.objects.push({
            id: siteId, x, y, level: 1,
            stats: { hp: CONFIG.CONSTRUCTION_BASE_HP, maxHp: CONFIG.CONSTRUCTION_BASE_HP, dmg: 0, speed: 0 },
            type: CONFIG.ENTITY_TYPES.CONSTRUCTION_SITE, team: player.team,
            materials: { bricks: 0 },
            requiredMaterials: { bricks: CONFIG.CONSTRUCTION_BASE_BRICKS_REQUIRED },
            constructionCompleteUntil: null,
            attackers: [],
            maxAttackers: CONFIG.MAX_ATTACKERS
        });
        this.logEvent(`${player.id} started a construction site at (${x}, ${y}).`);
        this.updateWorldState();
    }

    donateToSite(playerId) {
        const player = this.findPlayerById(playerId);
        if (!player) return;
        const site = this.state.world[player.y][player.x].objects.find(o => o.type === CONFIG.ENTITY_TYPES.CONSTRUCTION_SITE && o.team === player.team);
        if (!site) {
            this.logEvent("No friendly construction site in this area.", this.getClientByPlayerId(playerId));
            return;
        }
        const brickItem = player.inventory.find(item => item.name === 'Brick');
        if (!brickItem || brickItem.quantity <= 0) {
            this.logEvent("No bricks to donate.", this.getClientByPlayerId(playerId));
            return;
        }

        const needed = site.requiredMaterials.bricks - site.materials.bricks;
        const toDonate = Math.min(brickItem.quantity, needed);
        if (toDonate <= 0) {
            this.logEvent("Site does not need more bricks for the current upgrade.", this.getClientByPlayerId(playerId));
            return;
        }

        brickItem.quantity -= toDonate;
        site.materials.bricks += toDonate;
        this.logEvent(`${player.id} donated ${toDonate} bricks.`);

        if (site.materials.bricks >= site.requiredMaterials.bricks) {
            const timeAdded = site.requiredMaterials.bricks * CONFIG.CONSTRUCTION_TIME_PER_BRICK;
            const now = Date.now();
            const currentEndTime = site.constructionCompleteUntil && site.constructionCompleteUntil > now ? site.constructionCompleteUntil : now;
            site.constructionCompleteUntil = currentEndTime + timeAdded;
            this.logEvent(`Construction for next level has begun! Time remaining: ${Math.ceil((site.constructionCompleteUntil - now) / 1000)}s`);
        }

        if (brickItem.quantity <= 0) {
            player.inventory = player.inventory.filter(item => item.name !== 'Brick');
        }
        this.updateWorldState();
    }

    deploySiegeMachine(playerId) {
        const player = this.findPlayerById(playerId);
        if (!player || !player.team) {
            this.logEvent("You must be in a team to deploy siege engines.", this.getClientByPlayerId(playerId));
            return;
        }
        const enemySite = this.state.world[player.y][player.x].objects.find(o => o.type === CONFIG.ENTITY_TYPES.CONSTRUCTION_SITE && o.team !== player.team);
        if (!enemySite) { this.logEvent("There is no enemy construction site here to attack.", this.getClientByPlayerId(playerId)); return; }
        const brickItem = player.inventory.find(item => item.name === 'Brick');
        if (!brickItem || brickItem.quantity < CONFIG.SIEGE_MACHINE_COST) { this.logEvent(`You need ${CONFIG.SIEGE_MACHINE_COST} bricks to deploy a siege machine.`, this.getClientByPlayerId(playerId)); return; }

        brickItem.quantity -= CONFIG.SIEGE_MACHINE_COST;
        if (brickItem.quantity <= 0) player.inventory = player.inventory.filter(item => item.name !== 'Brick');

        const newMachineId = `siege_${player.team}_${Date.now()}`;
        this.state.objects.push({
            id: newMachineId, x: player.x, y: player.y, team: player.team,
            type: CONFIG.ENTITY_TYPES.SIEGE_MACHINE,
            stats: { hp: CONFIG.SIEGE_MACHINE_HP, maxHp: CONFIG.SIEGE_MACHINE_HP, dmg: CONFIG.SIEGE_MACHINE_DAMAGE, selfDmg: CONFIG.SIEGE_MACHINE_SELF_DAMAGE },
            targetId: enemySite.id,
            attackCooldown: 1000,
        });
        this.logEvent(`${player.id} deployed a siege machine!`);
        this.updateWorldState();
    }

    update() {
        let stateChanged = false;
        const destroyedEntities = new Set();

        // --- Player Attack Logic ---
        this.state.players.forEach(player => {
            if (player.isDead || !player.attacking) return;
            const target = this.findEntityById(player.attacking);

            if (!target || target.isDead || (target.stats && target.stats.hp <= 0)) {
                this.stopCombat(player);
                stateChanged = true;
                return;
            }

            if (!target.respawnUntil && player.x === target.x && player.y === target.y) {
                player.attackCooldown -= CONFIG.GAME_TICK;
                if (player.attackCooldown <= 0) {
                    stateChanged = true;
                    let damage = player.stats.dmg;
                    if (Math.random() * 100 < player.stats.critical) damage *= 2;
                    if (target.weakness && player.skills[target.weakness]) {
                        damage *= (1 + (player.skills[target.weakness].level / 100));
                    }
                    this.logCombat(`${player.id} deals ${damage.toFixed(1)} damage to ${target.id}.`);
                    target.stats.hp -= damage;

                    if (target.stats.hp <= 0) {
                        this.handleTargetDefeated(player, target);
                    }
                    player.attackCooldown = 1000 / player.stats.speed;
                }
            }
        });

        // --- Object Logic (Enemies, Siege, etc.) ---
        this.state.objects.forEach(obj => {
            // Mob Attack Logic
            if (obj.type === CONFIG.ENTITY_TYPES.MOB && obj.attackers.length > 0 && obj.stats.hp > 0 && !obj.respawnUntil) {
                obj.attackCooldown -= CONFIG.GAME_TICK;
                if (obj.attackCooldown <= 0 && obj.stats.dmg > 0) {
                    stateChanged = true;
                    const randomAttackerId = obj.attackers[Math.floor(Math.random() * obj.attackers.length)];
                    const playerToAttack = this.findPlayerById(randomAttackerId);
                    if (playerToAttack && !playerToAttack.isDead) {
                        if (!(Math.random() * 100 < playerToAttack.stats.dodge)) {
                            this.logCombat(`${obj.id} deals ${obj.stats.dmg.toFixed(0)} damage to ${playerToAttack.id}.`);
                            playerToAttack.stats.hp -= obj.stats.dmg;
                            if (playerToAttack.stats.hp <= 0) {
                                playerToAttack.stats.hp = 0;
                                playerToAttack.isDead = true;
                                this.stopCombat(playerToAttack);
                                this.logEvent(`${playerToAttack.id} has been defeated by ${obj.id}!`);
                            }
                        } else {
                            this.logCombat(`${playerToAttack.id} dodges an attack from ${obj.id}.`);
                        }
                    }
                    obj.attackCooldown = (1000 / obj.stats.speed);
                }
            }

            // Respawn Logic
            if (obj.type === CONFIG.ENTITY_TYPES.MOB && obj.respawnUntil && Date.now() >= obj.respawnUntil) {
                obj.respawnUntil = null;
                obj.stats.hp = obj.stats.maxHp;
                this.logEvent(`${obj.id} has respawned!`);
                stateChanged = true;
                const reEngagingAttackers = [];
                const potentialAttackers = [...obj.attackers];
                potentialAttackers.forEach(attackerId => {
                    const player = this.findPlayerById(attackerId);
                    if (player && !player.isDead && player.x === obj.x && player.y === obj.y) {
                        reEngagingAttackers.push(attackerId);
                    }
                });
                obj.attackers = reEngagingAttackers;
                obj.attackers.forEach(attackerId => {
                    this.startCombat(attackerId, obj.id);
                });
            }

            // Construction Logic
            if (obj.type === CONFIG.ENTITY_TYPES.CONSTRUCTION_SITE && obj.constructionCompleteUntil && Date.now() >= obj.constructionCompleteUntil) {
                obj.constructionCompleteUntil = null;
                stateChanged = true;
                obj.level++;
                obj.materials.bricks = 0;
                obj.requiredMaterials.bricks = CONFIG.CONSTRUCTION_BASE_BRICKS_REQUIRED * obj.level;
                obj.stats.maxHp = CONFIG.CONSTRUCTION_BASE_HP * obj.level;
                obj.stats.hp = obj.stats.maxHp;
                this.logEvent(`Construction site ${obj.id} has been upgraded to Level ${obj.level}!`);
            }

            // Siege Machine Logic
            if (obj.type === CONFIG.ENTITY_TYPES.SIEGE_MACHINE) {
                obj.attackCooldown -= CONFIG.GAME_TICK;
                if (obj.attackCooldown <= 0) {
                    obj.attackCooldown = 1000;
                    stateChanged = true;
                    const targetSite = this.findEntityById(obj.targetId);

                    if (targetSite && targetSite.stats.hp > 0) {
                        targetSite.stats.hp -= obj.stats.dmg;
                        obj.stats.hp -= obj.stats.selfDmg;
                        this.logEvent(`${obj.id} dealt ${obj.stats.dmg} damage to ${targetSite.id} and took ${obj.stats.selfDmg} damage.`);

                        if (targetSite.stats.hp <= 0) {
                            this.logEvent(`${targetSite.id} has been destroyed by siege engines!`);
                            destroyedEntities.add(targetSite.id);
                            this.state.objects.forEach(m => {
                                if (m.type === 'siege' && m.targetId === targetSite.id) destroyedEntities.add(m.id);
                            });
                        }
                    } else {
                        destroyedEntities.add(obj.id);
                    }

                    if (obj.stats.hp <= 0) {
                        destroyedEntities.add(obj.id);
                        this.logEvent(`${obj.id} has been destroyed.`);
                    }
                }
            }
        });

        if (destroyedEntities.size > 0) {
            this.state.objects = this.state.objects.filter(o => !destroyedEntities.has(o.id));
            stateChanged = true;
        }

        if (stateChanged) this.updateWorldState();
    }

    handleTargetDefeated(killer, target) {
        this.logEvent(`${killer.id} defeated ${target.id}!`);

        if (target.type === CONFIG.ENTITY_TYPES.PLAYER) {
            target.isDead = true;
        } else if (target.type === CONFIG.ENTITY_TYPES.MOB) {
            target.level++;
            this.scaleEnemyStats(target);
            target.respawnUntil = Date.now() + CONFIG.ENEMY_RESPAWN_TIME;

            const template = CONFIG.ENEMY_TEMPLATES[target.templateId];
            if (template.drops) {
                template.drops.forEach(drop => {
                    if (Math.random() < drop.chance) {
                        const quantity = Math.floor(Math.random() * (drop.quantity[1] - drop.quantity[0] + 1)) + drop.quantity[0];

                        target.attackers.forEach(attackerId => {
                            const p = this.findPlayerById(attackerId);
                            if (p && !p.isDead) {
                                let item = p.inventory.find(i => i.name === drop.name);
                                if (item && item.quantity !== undefined) {
                                    item.quantity += quantity;
                                } else {
                                    p.inventory.push({ name: drop.name, quantity: quantity });
                                }
                                this.logEvent(`${p.id} received ${quantity}x ${drop.name}!`, this.getClientByPlayerId(p.id));
                            }
                        });
                    }
                });
            }
        }
    }

    updateWorldState() {
        this.state.players.forEach(p => this.recalculatePlayerStats(p));

        for (let y = 0; y < CONFIG.MAP_SIZE; y++) {
            for (let x = 0; x < CONFIG.MAP_SIZE; x++) {
                this.state.world[y][x].players = [];
                this.state.world[y][x].objects = [];
            }
        }
        this.state.players.forEach(p => { if (!p.isDead) this.state.world[p.y][p.x].players.push(p); });
        this.state.objects.forEach(o => this.state.world[o.y][o.x].objects.push(o));

        this.broadcast({ type: 'gameState', state: this.getSanitizedState() });
    }

    getSanitizedState() {
        return JSON.parse(JSON.stringify(this.state));
    }

    findEntityById = (id) => this.state.players.find(p => p.id === id) || this.state.objects.find(o => o.id === id);

    getClientByPlayerId(playerId) {
        for (const client of wss.clients) {
            if (client.playerId === playerId) {
                return client;
            }
        }
        return null;
    }
}

// ===================================================================================
// --- WEBSOCKET SERVER ---
// ===================================================================================

const wss = new WebSocket.Server({ port: 8080 });

const game = new Game(
    (payload) => {
        const message = JSON.stringify(payload);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    },
    (client, payload) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    }
);

game.init();

wss.on('connection', ws => {
    console.log('Client connected');
    game.sendToClient(ws, {type: 'log', message: 'Welcome to the game! Please create a character.'});

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            console.log(`Received from ${ws.playerId || 'new client'}:`, data);

            if (data.action === 'create') {
                if (ws.playerId) {
                    game.sendToClient(ws, {type: 'error', message: 'Player already created.'});
                    return;
                }
                game.createPlayer(ws);
                return;
            }

            if (!ws.playerId) {
                game.sendToClient(ws, {type: 'error', message: 'You must create a player first.'});
                return;
            }

            switch (data.action) {
                case 'move': game.movePlayer(ws.playerId, data.x, data.y); break;
                case 'attack': game.startCombat(ws.playerId, data.targetId); break;
                case 'respawn': game.respawnPlayer(ws.playerId); break;
                case 'build': game.buildConstructionSite(ws.playerId); break;
                case 'donate': game.donateToSite(ws.playerId); break;
                case 'deploySiege': game.deploySiegeMachine(ws.playerId); break;
                case 'chat': game.handleChatMessage(ws.playerId, data); break;
                case 'equip-item': game.equipItem(ws.playerId, data.itemIndex); break;
                case 'unequip-item': game.unequipItem(ws.playerId, data.slot); break;
                case 'create-team': game.createTeam(ws.playerId, data.teamName); break;
                case 'join-team': game.joinTeam(ws.playerId, data.teamId); break;
                case 'leave-team': game.leaveTeam(ws.playerId); break;
                case 'update-team-settings': game.updateTeamSettings(ws.playerId, data); break;
                case 'request-to-join': game.requestToJoin(ws.playerId, data.teamId); break;
                case 'resolve-join-request': game.resolveJoinRequest(ws.playerId, data); break;
                default:
                   game.sendToClient(ws, {type: 'error', message: 'Unknown action.'});
            }

        } catch (e) {
            console.error('Failed to process message:', e);
            game.sendToClient(ws, {type: 'error', message: 'Invalid message format.'});
        }
    });

    ws.on('close', () => {
        console.log(`Client ${ws.playerId || ''} disconnected`);
        if (ws.playerId) {
            const player = game.findPlayerById(ws.playerId);
            if (player) {
                game.logEvent(`Player ${player.id} has left the game.`);
                game.stopCombat(player);
                game.leaveTeam(ws.playerId, true); // Silently leave team on disconnect
            }
            game.state.players = game.state.players.filter(p => p.id !== ws.playerId);
            game.updateWorldState();
        }
    });
});

console.log('WebSocket server started on port 8080');
