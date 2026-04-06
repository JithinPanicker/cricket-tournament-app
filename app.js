// ---------- DATABASE & INIT ----------
const db = new Dexie('CricketArenaDB');
db.version(5).stores({
    teams: '++id, name, shortName',
    players: '++id, teamId, name, role, battingOrder',
    tournaments: '++id, name, createdAt, active',
    matches: '++id, tournamentId, teamAId, teamBId, matchType, round, status, winnerId, date, inningsData, isPlayoff, tossWinner, tossDecision, battingFirst, rawScorecard',
    playerStats: '++id, tournamentId, playerId, runs, balls, wickets, runsConceded, oversBowled, innings, highestScore, bestWickets',
    matchDrafts: '++id, matchId, draftData, updatedAt'
});

const TEAMS_DATA = [
    { name: "Chennai Super Kings", short: "CSK", players: ["V. Kohli","M. Agarwal","R. Pant","S. Dube","R. Parag","W. Sundar","N. Rana","R. Ashwin","M. Shami","Y. Chahal","T. Natarajan"] },
    { name: "Mumbai Indians", short: "MI", players: ["S. Dhawan","S. Iyer","S. Samson","H. Pandya","D. Hooda","K. Pandya","A. Patel","B. Kumar","V. Chakravarthy","R. Bishnoi","M. Siraj"] },
    { name: "Kolkata Knight Riders", short: "KKR", players: ["Y. Jaiswal","L. Rahul","R. Jadeja","M. Pandey","V. Iyer","R. Tewatia","H. Patel","S. Thakur","U. Malik","K. Yadav","J. Bumrah"] },
    { name: "Delhi Capitals", short: "DC", players: ["R. Sharma","S. Gill","A. Sharma","P. Shaw","D. Karthik","N. Reddy","J. Yadav","D. Chahar","T. Deshpande","M. Yadav","R. Kishore"] },
    { name: "Rajasthan Royals", short: "RR", players: ["I. Kishan","S. Yadav","T. Varma","R. Singh","D. Jurel","D. Padikkal","S. Mavi","P. Krishna","R. Chahar","U. Yadav","N. Saini"] },
    { name: "Punjab Kings", short: "PBKS", players: ["R. Gaikwad","S. Sudharsan","J. Sharma","R. Tripathi","R. Singh","K. Gowtham","A. Khan","H. Rana","M. Kumar","K. Ahmed","A. Singh"] }
];

let currentTournamentId = null;

async function initDB() {
    await db.open();
    const teamCount = await db.teams.count();
    if(teamCount === 0) {
        for(let idx=0; idx<TEAMS_DATA.length; idx++) {
            let t = TEAMS_DATA[idx];
            let teamId = await db.teams.add({ name: t.name, shortName: t.short });
            for(let i=0; i<t.players.length; i++) {
                await db.players.add({ teamId, name: t.players[i], role: i<2?"Batter":(i>7?"Bowler":"All-rounder"), battingOrder: i+1 });
            }
        }
    }
    const tourneys = await db.tournaments.toArray();
    if(tourneys.length === 0) {
        await db.tournaments.add({ name: "Champions Trophy 2025", createdAt: new Date(), active: true });
    }
    await loadTournaments();
}

async function loadTournaments() {
    let tours = await db.tournaments.orderBy('createdAt').reverse().toArray();
    let select = document.getElementById('tournamentSelect');
    select.innerHTML = '';
    tours.forEach(t => {
        let opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.name} ${t.active ? '✓' : ''}`;
        if(t.active) currentTournamentId = t.id;
        select.appendChild(opt);
    });
    if(currentTournamentId) select.value = currentTournamentId;
    else if(tours.length) currentTournamentId = tours[0].id;
    await switchTournament();
}

async function switchTournament() {
    currentTournamentId = parseInt(document.getElementById('tournamentSelect').value);
    await refreshAllPanels();
}

// ---------- DOUBLE ROUND ROBIN (30 matches) ----------
const SCHEDULE_FIXTURES = [
    ["CSK","MI"],["KKR","PBKS"],["DC","RR"],["CSK","KKR"],["MI","DC"],["RR","PBKS"],
    ["CSK","DC"],["MI","RR"],["KKR","PBKS"],["CSK","RR"],["MI","PBKS"],["KKR","DC"],
    ["CSK","PBKS"],["MI","KKR"],["DC","RR"],["CSK","MI"],["KKR","PBKS"],["DC","RR"],
    ["CSK","KKR"],["MI","DC"],["RR","PBKS"],["CSK","DC"],["MI","RR"],["KKR","PBKS"],
    ["CSK","RR"],["MI","PBKS"],["KKR","DC"],["CSK","PBKS"],["MI","KKR"],["DC","RR"]
];

async function generateLeagueMatches() {
    if(!currentTournamentId) return Swal.fire("Select tournament");
    const existing = await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 0 }).count();
    if(existing > 0) {
        let confirm = await Swal.fire({title: "League matches exist", text: "Replace existing league matches? This will delete previous league matches.", showCancelButton:true});
        if(!confirm.isConfirmed) return;
        await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 0 }).delete();
        await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 1 }).delete();
    }
    let teamsMap = new Map();
    let allTeams = await db.teams.toArray();
    allTeams.forEach(t => { teamsMap.set(t.shortName, t.id); });
    for(let fix of SCHEDULE_FIXTURES) {
        let teamAId = teamsMap.get(fix[0]);
        let teamBId = teamsMap.get(fix[1]);
        if(teamAId && teamBId) {
            await db.matches.add({ tournamentId: currentTournamentId, teamAId, teamBId, matchType: "league", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 0, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
        }
    }
    Swal.fire("Generated 30 league matches!");
    await refreshAllPanels();
}

// ---------- AUTO PLAYOFFS ----------
async function autoGeneratePlayoffsIfNeeded() {
    const leagueMatches = await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 0 }).toArray();
    const completedLeague = leagueMatches.filter(m => m.status === 'completed');
    if(completedLeague.length !== 30) return;

    const existingPlayoffs = await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 1 }).count();
    if(existingPlayoffs > 0) return;

    const standings = await computeStandings();
    if(standings.length < 4) return;
    const top4 = standings.slice(0,4).map(s => s.teamId);
    const [first, second, third, fourth] = top4;

    await db.matches.add({ tournamentId: currentTournamentId, teamAId: first, teamBId: second, matchType: "Qualifier 1", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: third, teamBId: fourth, matchType: "Eliminator", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Qualifier 2", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Final", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });

    Swal.fire("All league matches completed! Playoffs have been automatically created.");
    await refreshAllPanels();
}

// ---------- STANDINGS & POINTS ----------
async function computeStandings() {
    let matches = await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 0 }).toArray();
    let teams = await db.teams.toArray();
    let pointsMap = new Map();
    teams.forEach(t => pointsMap.set(t.id, { teamId: t.id, name: t.name, played:0, won:0, lost:0, tied:0, points:0, nrr:0, runsFor:0, oversFor:0, runsAgainst:0, oversAgainst:0 }));
    for(let m of matches) {
        if(m.status !== "completed" || !m.winnerId) continue;
        let teamA = m.teamAId, teamB = m.teamBId, winner = m.winnerId;
        let statsA = pointsMap.get(teamA), statsB = pointsMap.get(teamB);
        if(statsA && statsB) {
            statsA.played++; statsB.played++;
            if(winner === teamA) { statsA.won++; statsB.lost++; statsA.points+=2; }
            else if(winner === teamB) { statsB.won++; statsA.lost++; statsB.points+=2; }
            else { statsA.tied++; statsB.tied++; statsA.points+=1; statsB.points+=1; }
            if(m.inningsData) {
                let inn = m.inningsData;
                if(inn.teamARuns && inn.teamAOver) { statsA.runsFor += inn.teamARuns; statsA.oversFor += inn.teamAOver; statsB.runsAgainst += inn.teamARuns; statsB.oversAgainst += inn.teamAOver; }
                if(inn.teamBRuns && inn.teamBOver) { statsB.runsFor += inn.teamBRuns; statsB.oversFor += inn.teamBOver; statsA.runsAgainst += inn.teamBRuns; statsA.oversAgainst += inn.teamBOver; }
            }
        }
    }
    let standingsArr = Array.from(pointsMap.values());
    for(let s of standingsArr) {
        s.nrr = ((s.runsFor/(s.oversFor||1)) - (s.runsAgainst/(s.oversAgainst||1))).toFixed(2);
    }
    standingsArr.sort((a,b)=> b.points - a.points || parseFloat(b.nrr) - parseFloat(a.nrr));
    return standingsArr;
}

async function renderPointsTable() {
    let standings = await computeStandings();
    let html = `<table class="stat-table"><thead><tr><th>Team</th><th>Pld</th><th>W</th><th>L</th><th>Pts</th><th>NRR</th></tr></thead><tbody>`;
    standings.forEach(s=>{
        html += `<tr><td>${s.name}</td><td>${s.played}</td><td>${s.won}</td><td>${s.lost}</td><td><b>${s.points}</b></td><td>${s.nrr}</td></tr>`;
    });
    html+=`</tbody></table>`;
    document.getElementById('pointsTable').innerHTML = html;
}

// ---------- STATS REBUILD (used after edit) ----------
async function rebuildAllStats(tournamentId) {
    await db.playerStats.where({ tournamentId }).delete();
    const matches = await db.matches.where({ tournamentId, status: 'completed' }).toArray();
    for(let match of matches) {
        if(match.rawScorecard) {
            let playersA = await db.players.where('teamId').equals(match.teamAId).toArray();
            let playersB = await db.players.where('teamId').equals(match.teamBId).toArray();
            for(let key in match.rawScorecard) {
                if(key.startsWith('runs_')) {
                    let parts = key.split('_');
                    let playerId = parseInt(parts[2]);
                    let runs = parseInt(match.rawScorecard[key]) || 0;
                    let ballsKey = key.replace('runs_', 'balls_');
                    let balls = parseInt(match.rawScorecard[ballsKey]) || 0;
                    let existing = await db.playerStats.where({ tournamentId, playerId }).first();
                    if(!existing) existing = { tournamentId, playerId, runs:0, balls:0, wickets:0, runsConceded:0, oversBowled:0, highestScore:0, bestWickets:0 };
                    existing.runs += runs;
                    existing.balls += balls;
                    if(runs > existing.highestScore) existing.highestScore = runs;
                    await db.playerStats.put(existing);
                }
                if(key.startsWith('wickets_')) {
                    let parts = key.split('_');
                    let playerId = parseInt(parts[2]);
                    let wickets = parseInt(match.rawScorecard[key]) || 0;
                    let runsConcKey = key.replace('wickets_', 'runsConc_');
                    let runsConc = parseInt(match.rawScorecard[runsConcKey]) || 0;
                    let oversKey = key.replace('wickets_', 'overs_');
                    let overs = parseFloat(match.rawScorecard[oversKey]) || 0;
                    let existing = await db.playerStats.where({ tournamentId, playerId }).first();
                    if(!existing) existing = { tournamentId, playerId, runs:0, balls:0, wickets:0, runsConceded:0, oversBowled:0, highestScore:0, bestWickets:0 };
                    existing.wickets += wickets;
                    existing.runsConceded += runsConc;
                    existing.oversBowled += overs;
                    if(wickets > existing.bestWickets) existing.bestWickets = wickets;
                    await db.playerStats.put(existing);
                }
            }
        }
    }
}

// ---------- PLAYER STATS & CAPS ----------
async function computePlayerStats() {
    let stats = await db.playerStats.where({ tournamentId: currentTournamentId }).toArray();
    let players = await db.players.toArray();
    let playerMap = new Map(players.map(p=>[p.id, p]));
    let runsArr = stats.filter(s=>s.runs>0).sort((a,b)=>b.runs - a.runs);
    let wicketsArr = stats.filter(s=>s.wickets>0).sort((a,b)=>b.wickets - a.wickets);
    let topRuns = runsArr.slice(0,5);
    let topWkts = wicketsArr.slice(0,5);
    let runsHtml = topRuns.map(s=>{ let pl = playerMap.get(s.playerId); let sr = s.balls ? ((s.runs/s.balls)*100).toFixed(1) : 0; return `<div class="player-row"><span>${pl?.name||"?"}</span><span><b>${s.runs}</b> runs | SR ${sr}</span></div>`; }).join('');
    let wktHtml = topWkts.map(s=>{ let pl = playerMap.get(s.playerId); let avg = s.wickets ? (s.runsConceded/s.wickets).toFixed(1) : '-'; return `<div class="player-row"><span>${pl?.name||"?"}</span><span><b>${s.wickets}</b> wkts | Avg ${avg}</span></div>`; }).join('');
    document.getElementById('topRunsList').innerHTML = runsHtml || "<div>No data</div>";
    document.getElementById('topWicketsList').innerHTML = wktHtml || "<div>No data</div>";
    let orange = runsArr[0]; let purple = wicketsArr[0];
    document.getElementById('orangeCapName').innerText = orange ? (playerMap.get(orange.playerId)?.name||'--') : '--';
    document.getElementById('orangeCapRuns').innerText = orange ? `${orange.runs} runs` : '';
    document.getElementById('purpleCapName').innerText = purple ? (playerMap.get(purple.playerId)?.name||'--') : '--';
    document.getElementById('purpleCapWkts').innerText = purple ? `${purple.wickets} wickets` : '';
}

// ---------- MATCH UI WITH EDIT & REMATCH ----------
async function renderMatchesList() {
    let matches = await db.matches.where({ tournamentId: currentTournamentId }).reverse().sortBy('id');
    let teams = await db.teams.toArray();
    let teamDict = Object.fromEntries(teams.map(t=>[t.id, t]));
    let container = document.getElementById('matchesListContainer');
    if(!matches.length) { container.innerHTML = "<div class='card'>No matches. Generate league or create custom match.</div>"; return; }
    let html = '';
    for(let m of matches) {
        let teamAName = teamDict[m.teamAId]?.name || 'TBD';
        let teamBName = teamDict[m.teamBId]?.name || 'TBD';
        let statusBadge = m.status === 'completed' ? `✅ ${teamDict[m.winnerId]?.name || 'winner'}` : (m.status==='pending' ? '⏳ Pending' : 'In Progress');
        let tossInfo = m.tossWinner ? `🎲 Toss: ${teamDict[m.tossWinner]?.shortName} chose ${m.tossDecision}` : '';
        let draftInfo = '';
        const draft = await db.matchDrafts.where('matchId').equals(m.id).first();
        if(draft && m.status !== 'completed') draftInfo = ' 📝 Draft saved';
        let actionButtons = '';
        if(m.status === 'completed') {
            actionButtons = `<button class="edit-btn" onclick="event.stopPropagation(); editCompletedMatch(${m.id})">✏️ Edit</button>
                            <button class="rematch-btn" onclick="event.stopPropagation(); rematchMatch(${m.id})">🔄 Rematch</button>`;
        }
        html += `<div class="match-item" onclick="openScorecardForMatch(${m.id})">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong>${teamAName} vs ${teamBName}</strong>
                        <div><span class="badge">${m.matchType || 'League'}</span> ${actionButtons}</div>
                    </div>
                    <div>${statusBadge}${draftInfo}</div>
                    <div style="font-size:12px;">${tossInfo}</div>
                </div>`;
    }
    container.innerHTML = html;
}

async function rematchMatch(originalMatchId) {
    const original = await db.matches.get(originalMatchId);
    if(!original) return;
    const { value: confirm } = await Swal.fire({
        title: 'Rematch?',
        text: `Create a new match between ${(await db.teams.get(original.teamAId))?.name} and ${(await db.teams.get(original.teamBId))?.name}?`,
        showCancelButton: true,
        confirmButtonText: 'Yes, create rematch'
    });
    if(!confirm) return;
    await db.matches.add({
        tournamentId: original.tournamentId,
        teamAId: original.teamAId,
        teamBId: original.teamBId,
        matchType: original.matchType === 'league' ? 'league' : 'rematch',
        status: 'pending',
        winnerId: null,
        date: new Date().toISOString(),
        inningsData: null,
        isPlayoff: original.isPlayoff,
        tossWinner: null,
        tossDecision: null,
        battingFirst: null,
        rawScorecard: null
    });
    Swal.fire("Rematch created! You can now enter the new match.");
    await refreshAllPanels();
}

// ========== FIXED EDIT FUNCTION ==========
async function editCompletedMatch(matchId) {
    try {
        const match = await db.matches.get(matchId);
        if (!match || match.status !== 'completed') {
            Swal.fire("Error", "Match is not completed or doesn't exist.", "error");
            return;
        }

        // Confirm edit
        const confirm = await Swal.fire({
            title: 'Edit Match?',
            text: 'This will revert the match to pending state and remove its stats. You can then re-enter the scorecard.',
            showCancelButton: true,
            confirmButtonText: 'Yes, edit match',
            cancelButtonText: 'Cancel'
        });
        if (!confirm.isConfirmed) return;

        // Remove stats for this match by rebuilding all stats from other completed matches
        await db.playerStats.where({ tournamentId: currentTournamentId }).delete();
        const otherMatches = await db.matches.where({ tournamentId: currentTournamentId, status: 'completed' }).filter(m => m.id !== matchId).toArray();
        for (let om of otherMatches) {
            if (om.rawScorecard) {
                await applyMatchStatsFromRaw(om);
            } else {
                // If old match without rawScorecard, we cannot restore its stats – but those stats are already gone.
                // Warn user that stats from this match will be lost.
                console.warn("Match without rawScorecard cannot be restored:", om.id);
            }
        }

        // Mark match as pending
        await db.matches.update(matchId, { status: 'pending', winnerId: null });
        await refreshAllPanels();

        // Open the scorecard for editing (pass true to indicate edit mode)
        await openScorecardForMatch(matchId, true);
        Swal.fire("Match is now editable. Make changes and save again.", "", "info");
    } catch (err) {
        console.error(err);
        Swal.fire("Error", "Failed to edit match. See console for details.", "error");
    }
}

async function applyMatchStatsFromRaw(match) {
    if (!match.rawScorecard) return;
    let playersA = await db.players.where('teamId').equals(match.teamAId).toArray();
    let playersB = await db.players.where('teamId').equals(match.teamBId).toArray();
    for (let key in match.rawScorecard) {
        if (key.startsWith('runs_')) {
            let parts = key.split('_');
            let playerId = parseInt(parts[2]);
            let runs = parseInt(match.rawScorecard[key]) || 0;
            let ballsKey = key.replace('runs_', 'balls_');
            let balls = parseInt(match.rawScorecard[ballsKey]) || 0;
            let existing = await db.playerStats.where({ tournamentId: match.tournamentId, playerId }).first();
            if (!existing) existing = { tournamentId: match.tournamentId, playerId, runs:0, balls:0, wickets:0, runsConceded:0, oversBowled:0, highestScore:0, bestWickets:0 };
            existing.runs += runs;
            existing.balls += balls;
            if (runs > existing.highestScore) existing.highestScore = runs;
            await db.playerStats.put(existing);
        }
        if (key.startsWith('wickets_')) {
            let parts = key.split('_');
            let playerId = parseInt(parts[2]);
            let wickets = parseInt(match.rawScorecard[key]) || 0;
            let runsConcKey = key.replace('wickets_', 'runsConc_');
            let runsConc = parseInt(match.rawScorecard[runsConcKey]) || 0;
            let oversKey = key.replace('wickets_', 'overs_');
            let overs = parseFloat(match.rawScorecard[oversKey]) || 0;
            let existing = await db.playerStats.where({ tournamentId: match.tournamentId, playerId }).first();
            if (!existing) existing = { tournamentId: match.tournamentId, playerId, runs:0, balls:0, wickets:0, runsConceded:0, oversBowled:0, highestScore:0, bestWickets:0 };
            existing.wickets += wickets;
            existing.runsConceded += runsConc;
            existing.oversBowled += overs;
            if (wickets > existing.bestWickets) existing.bestWickets = wickets;
            await db.playerStats.put(existing);
        }
    }
}

// ---------- SCORECARD MODAL (toss, draft, edit) ----------
async function openScorecardForMatch(matchId, isEdit = false) {
    let match = await db.matches.get(matchId);
    if (!match) return;
    if (match.status === 'completed' && !isEdit) {
        Swal.fire("Match already completed", "Use Edit button to modify.", "info");
        return;
    }
    document.getElementById('currentMatchId').value = matchId;
    document.getElementById('modalMatchTitle').innerHTML = `Enter Scorecard: ${(await db.teams.get(match.teamAId))?.name} vs ${(await db.teams.get(match.teamBId))?.name}`;
    
    if (match.tossWinner && match.tossDecision) {
        let teamDict = Object.fromEntries((await db.teams.toArray()).map(t=>[t.id, t]));
        document.getElementById('tossInfo').innerHTML = `<div class="badge" style="background:#ffe0b5;">Toss: ${teamDict[match.tossWinner]?.name} won and chose to ${match.tossDecision} first.</div>`;
        await loadScorecardForm(match, match.battingFirst);
        if (match.rawScorecard) {
            for (let key in match.rawScorecard) {
                let input = document.querySelector(`[name="${key}"]`) || document.getElementById(key);
                if (input) input.value = match.rawScorecard[key];
            }
        }
        await restoreDraft(matchId);
    } else {
        let teams = await db.teams.toArray();
        let teamA = teams.find(t=>t.id === match.teamAId);
        let teamB = teams.find(t=>t.id === match.teamBId);
        const { value: tossWinnerId } = await Swal.fire({
            title: 'Toss Time!',
            text: `Who won the toss?`,
            input: 'select',
            inputOptions: { [teamA.id]: teamA.name, [teamB.id]: teamB.name },
            showCancelButton: true
        });
        if (!tossWinnerId) { closeScorecardModal(); return; }
        const { value: decision } = await Swal.fire({
            title: 'Decision',
            text: `${teams.find(t=>t.id==tossWinnerId)?.name} won toss. Choose to:`,
            input: 'select',
            inputOptions: { 'bat': 'Bat First', 'bowl': 'Bowl First' }
        });
        if (!decision) { closeScorecardModal(); return; }
        let battingFirstId = decision === 'bat' ? parseInt(tossWinnerId) : (tossWinnerId == match.teamAId ? match.teamBId : match.teamAId);
        await db.matches.update(matchId, { tossWinner: parseInt(tossWinnerId), tossDecision: decision, battingFirst: battingFirstId });
        match = await db.matches.get(matchId);
        document.getElementById('tossInfo').innerHTML = `<div class="badge" style="background:#ffe0b5;">Toss: ${teams.find(t=>t.id==tossWinnerId)?.name} won and chose to ${decision} first.</div>`;
        await loadScorecardForm(match, battingFirstId);
    }
    document.getElementById('scorecardModal').classList.add('active');
}

async function loadScorecardForm(match, battingFirstTeamId) {
    let teamA = await db.teams.get(match.teamAId);
    let teamB = await db.teams.get(match.teamBId);
    let playersA = await db.players.where('teamId').equals(match.teamAId).toArray();
    let playersB = await db.players.where('teamId').equals(match.teamBId).toArray();
    
    let firstBatTeam = (battingFirstTeamId === match.teamAId) ? teamA : teamB;
    let firstBowlingTeam = (firstBatTeam.id === teamA.id) ? teamB : teamA;
    let firstBatPlayers = (firstBatTeam.id === teamA.id) ? playersA : playersB;
    let firstBowlPlayers = (firstBatTeam.id === teamA.id) ? playersB : playersA;
    let secondBatTeam = (firstBatTeam.id === teamA.id) ? teamB : teamA;
    let secondBatPlayers = (secondBatTeam.id === teamA.id) ? playersA : playersB;
    let secondBowlPlayers = (secondBatTeam.id === teamA.id) ? playersB : playersA;

    let container = document.getElementById('inningsContainer');
    container.innerHTML = `
        <div class="innings-block"><h4>🏏 Innings 1: ${firstBatTeam.name} Batting</h4>
        ${firstBatPlayers.map(p => `<div style="display:flex; gap:8px; margin-bottom:6px;"><span style="width:120px;">${p.name}</span><input type="number" placeholder="Runs" name="runs_${firstBatTeam.id}_${p.id}" class="runs_${firstBatTeam.id}_${p.id}" style="width:70px;"><input type="number" placeholder="Balls" name="balls_${firstBatTeam.id}_${p.id}" class="balls_${firstBatTeam.id}_${p.id}" style="width:70px;"></div>`).join('')}
        <h4>🎯 Bowling (${firstBowlingTeam.name})</h4>
        ${firstBowlPlayers.map(p => `<div><span>${p.name}</span> <input type="number" placeholder="Overs (max 20)" name="overs_${firstBowlingTeam.id}_${p.id}" class="overs_${firstBowlingTeam.id}_${p.id}" step="0.1" min="0" max="20" style="width:70px;"> <input type="number" placeholder="Runs" name="runsConc_${firstBowlingTeam.id}_${p.id}" class="runsConc_${firstBowlingTeam.id}_${p.id}" style="width:70px;"> <input type="number" placeholder="Wickets" name="wickets_${firstBowlingTeam.id}_${p.id}" class="wickets_${firstBowlingTeam.id}_${p.id}" style="width:70px;"></div>`).join('')}
        <div><label>Extras</label><input type="number" name="extras1" id="extras1" value="0"></div>
        </div>
        <div class="innings-block"><h4>🏏 Innings 2: ${secondBatTeam.name} Batting</h4>
        ${secondBatPlayers.map(p => `<div style="display:flex; gap:8px;"><span style="width:120px;">${p.name}</span><input type="number" placeholder="Runs" name="runs_${secondBatTeam.id}_${p.id}" class="runs_${secondBatTeam.id}_${p.id}" style="width:70px;"><input type="number" placeholder="Balls" name="balls_${secondBatTeam.id}_${p.id}" class="balls_${secondBatTeam.id}_${p.id}" style="width:70px;"></div>`).join('')}
        <h4>🎯 Bowling (${secondBowlPlayers[0]?.teamId ? (secondBowlPlayers[0].teamId === teamA.id ? teamA.name : teamB.name) : ''})</h4>
        ${secondBowlPlayers.map(p => `<div><span>${p.name}</span> <input type="number" placeholder="Overs (max 20)" name="overs_${secondBowlPlayers[0]?.teamId}_${p.id}" class="overs_${secondBowlPlayers[0]?.teamId}_${p.id}" step="0.1" min="0" max="20" style="width:70px;"> <input type="number" placeholder="Runs" name="runsConc_${secondBowlPlayers[0]?.teamId}_${p.id}" class="runsConc_${secondBowlPlayers[0]?.teamId}_${p.id}" style="width:70px;"> <input type="number" placeholder="Wickets" name="wickets_${secondBowlPlayers[0]?.teamId}_${p.id}" class="wickets_${secondBowlPlayers[0]?.teamId}_${p.id}" style="width:70px;"></div>`).join('')}
        <div><label>Extras</label><input type="number" name="extras2" id="extras2" value="0"></div>
        </div>`;
}

window.closeScorecardModal = () => {
    document.getElementById('scorecardModal').classList.remove('active');
    document.getElementById('currentMatchId').value = '';
};

document.getElementById('pauseMatchBtn')?.addEventListener('click', async () => {
    const matchId = parseInt(document.getElementById('currentMatchId').value);
    if (!matchId) return;
    await saveDraft(matchId);
    Swal.fire("Draft saved!", "You can resume this match later.", "success");
    closeScorecardModal();
});

async function saveDraft(matchId) {
    const match = await db.matches.get(matchId);
    if (!match || match.status === 'completed') return false;
    const container = document.getElementById('inningsContainer');
    const inputs = container.querySelectorAll('input');
    const draftData = {};
    inputs.forEach(inp => {
        draftData[inp.name || inp.id] = inp.value;
    });
    const tossInfoDiv = document.getElementById('tossInfo');
    draftData.tossHtml = tossInfoDiv.innerHTML;
    await db.matchDrafts.put({ matchId, draftData, updatedAt: new Date() });
    return true;
}

async function restoreDraft(matchId) {
    const draft = await db.matchDrafts.where('matchId').equals(matchId).first();
    if (!draft) return false;
    for (let key in draft.draftData) {
        let input = document.querySelector(`[name="${key}"]`) || document.getElementById(key);
        if (input) input.value = draft.draftData[key];
    }
    if (draft.draftData.tossHtml) document.getElementById('tossInfo').innerHTML = draft.draftData.tossHtml;
    return true;
}

async function clearDraft(matchId) {
    await db.matchDrafts.where('matchId').equals(matchId).delete();
}

// Save match (create or edit)
document.getElementById('scorecardForm').onsubmit = async (e) => {
    e.preventDefault();
    let matchId = parseInt(document.getElementById('currentMatchId').value);
    let match = await db.matches.get(matchId);
    if (!match) return;

    let teamA = match.teamAId, teamB = match.teamBId;
    let battingFirstId = match.battingFirst;
    if (!battingFirstId) { Swal.fire("Toss not decided"); return; }

    let playersA = await db.players.where('teamId').equals(teamA).toArray();
    let playersB = await db.players.where('teamId').equals(teamB).toArray();

    // Collect raw data
    let rawData = {};
    const container = document.getElementById('inningsContainer');
    const inputs = container.querySelectorAll('input');
    inputs.forEach(inp => {
        if (inp.name) rawData[inp.name] = inp.value;
        else if (inp.id) rawData[inp.id] = inp.value;
    });
    rawData.extras1 = document.getElementById('extras1')?.value || '0';
    rawData.extras2 = document.getElementById('extras2')?.value || '0';

    // Calculate innings totals from rawData
    let firstBatTeamId = battingFirstId;
    let firstBowlTeamId = firstBatTeamId === teamA ? teamB : teamA;
    let secondBatTeamId = firstBatTeamId === teamA ? teamB : teamA;
    let secondBowlTeamId = secondBatTeamId === teamA ? teamB : teamA;

    let totalRuns1 = 0, totalOvers1 = 0;
    for (let p of (firstBatTeamId === teamA ? playersA : playersB)) {
        let runs = parseInt(rawData[`runs_${firstBatTeamId}_${p.id}`]) || 0;
        totalRuns1 += runs;
    }
    for (let p of (firstBowlTeamId === teamA ? playersA : playersB)) {
        let overs = parseFloat(rawData[`overs_${firstBowlTeamId}_${p.id}`]) || 0;
        if (overs > 20) { Swal.fire(`Overs cannot exceed 20 for ${p.name}`); return; }
        totalOvers1 += overs;
    }
    totalRuns1 += parseInt(rawData.extras1) || 0;

    let totalRuns2 = 0, totalOvers2 = 0;
    for (let p of (secondBatTeamId === teamA ? playersA : playersB)) {
        let runs = parseInt(rawData[`runs_${secondBatTeamId}_${p.id}`]) || 0;
        totalRuns2 += runs;
    }
    for (let p of (secondBowlTeamId === teamA ? playersA : playersB)) {
        let overs = parseFloat(rawData[`overs_${secondBowlTeamId}_${p.id}`]) || 0;
        if (overs > 20) { Swal.fire(`Overs cannot exceed 20 for ${p.name}`); return; }
        totalOvers2 += overs;
    }
    totalRuns2 += parseInt(rawData.extras2) || 0;

    let inningsData = {};
    if (firstBatTeamId === teamA) {
        inningsData.teamARuns = totalRuns1;
        inningsData.teamAOver = totalOvers1;
        inningsData.teamBRuns = totalRuns2;
        inningsData.teamBOver = totalOvers2;
    } else {
        inningsData.teamARuns = totalRuns2;
        inningsData.teamAOver = totalOvers2;
        inningsData.teamBRuns = totalRuns1;
        inningsData.teamBOver = totalOvers1;
    }

    let winnerId = null;
    if (inningsData.teamARuns > inningsData.teamBRuns) winnerId = teamA;
    else if (inningsData.teamBRuns > inningsData.teamARuns) winnerId = teamB;

    // Update match
    match.status = "completed";
    match.winnerId = winnerId;
    match.inningsData = inningsData;
    match.rawScorecard = rawData;
    await db.matches.update(matchId, match);
    
    // Rebuild all stats from scratch
    await rebuildAllStats(currentTournamentId);
    
    await clearDraft(matchId);
    Swal.fire("Match saved & stats updated!");
    closeScorecardModal();
    await refreshAllPanels();
    await autoGeneratePlayoffsIfNeeded();
};

// ---------- FORCE PLAYOFFS ----------
async function forceGeneratePlayoffs() {
    if(!currentTournamentId) return;
    const existing = await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 1 }).count();
    if(existing > 0) {
        let confirm = await Swal.fire({title: "Playoffs exist", text: "Replace existing playoffs?", showCancelButton:true});
        if(!confirm.isConfirmed) return;
        await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 1 }).delete();
    }
    const standings = await computeStandings();
    if(standings.length < 4) { Swal.fire("Need at least 4 teams with points"); return; }
    let top4 = standings.slice(0,4).map(s => s.teamId);
    let [first, second, third, fourth] = top4;
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: first, teamBId: second, matchType: "Qualifier 1", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: third, teamBId: fourth, matchType: "Eliminator", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Qualifier 2", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Final", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
    Swal.fire("Playoffs generated manually!");
    await refreshAllPanels();
}

// ---------- REFRESH & UPDATE BUTTON ----------
async function refreshAllPanels() {
    if(!currentTournamentId) return;
    await renderMatchesList();
    await computePlayerStats();
    await renderPointsTable();
}

document.getElementById('checkUpdatesBtn')?.addEventListener('click', async () => {
    if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
            await registration.update();
            if (registration.waiting) {
                registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                Swal.fire("Updating...", "App will reload in a moment.", "info");
            } else {
                Swal.fire("Already up to date!", "No new version found.", "info");
            }
        }
    }
});

navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        window.location.reload();
    }
});

// ---------- EVENT LISTENERS ----------
document.getElementById('tournamentSelect').addEventListener('change', switchTournament);
document.getElementById('newTournamentBtn').onclick = async () => {
    let { value: name } = await Swal.fire({ title: "Tournament name", input: 'text', inputValue: `Tournament ${new Date().getFullYear()}` });
    if(name) {
        await db.tournaments.add({ name, createdAt: new Date(), active: true });
        await loadTournaments();
    }
};
document.getElementById('genLeagueBtn').onclick = generateLeagueMatches;
document.getElementById('genPlayoffsBtn').onclick = forceGeneratePlayoffs;
document.getElementById('createCustomMatchBtn').onclick = async () => {
    let teams = await db.teams.toArray();
    let teamOpts = teams.map(t=>`<option value="${t.id}">${t.name}</option>`).join('');
    let { value: ids } = await Swal.fire({ title: "Create Custom Match", html: `<select id="teamA">${teamOpts}</select> vs <select id="teamB">${teamOpts}</select>`, preConfirm:()=>{ return { teamA: document.getElementById('teamA').value, teamB: document.getElementById('teamB').value }; } });
    if(ids) {
        await db.matches.add({ tournamentId: currentTournamentId, teamAId: parseInt(ids.teamA), teamBId: parseInt(ids.teamB), matchType: "custom", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff:0, tossWinner: null, tossDecision: null, battingFirst: null, rawScorecard: null });
        await refreshAllPanels();
        Swal.fire("Custom match added!");
    }
};

document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
        document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        let target = tab.getAttribute('data-tab');
        document.getElementById('dashboardPanel').classList.add('hidden-panel');
        document.getElementById('matchesPanel').classList.add('hidden-panel');
        document.getElementById('standingsPanel').classList.add('hidden-panel');
        document.getElementById('schedulePanel').classList.add('hidden-panel');
        if(target === 'dashboard') document.getElementById('dashboardPanel').classList.remove('hidden-panel');
        if(target === 'matches') document.getElementById('matchesPanel').classList.remove('hidden-panel');
        if(target === 'standings') document.getElementById('standingsPanel').classList.remove('hidden-panel');
        if(target === 'schedule') document.getElementById('schedulePanel').classList.remove('hidden-panel');
    });
});

initDB().then(()=>refreshAllPanels());

// Make functions globally available for HTML onclick
window.rematchMatch = rematchMatch;
window.editCompletedMatch = editCompletedMatch;
window.openScorecardForMatch = openScorecardForMatch;
