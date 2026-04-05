// ---------- DATABASE & INIT ----------
const db = new Dexie('CricketArenaDB');
db.version(2).stores({
    teams: '++id, name, shortName',
    players: '++id, teamId, name, role, battingOrder',
    tournaments: '++id, name, createdAt, active',
    matches: '++id, tournamentId, teamAId, teamBId, matchType, round, status, winnerId, date, inningsData, isPlayoff, tossWinner, tossDecision, battingFirst',
    playerStats: '++id, tournamentId, playerId, runs, balls, wickets, runsConceded, oversBowled, innings, highestScore, bestWickets',
    matchDrafts: '++id, matchId, draftData, updatedAt'  // new table for paused drafts
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
            await db.matches.add({ tournamentId: currentTournamentId, teamAId, teamBId, matchType: "league", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 0, tossWinner: null, tossDecision: null, battingFirst: null });
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

    await db.matches.add({ tournamentId: currentTournamentId, teamAId: first, teamBId: second, matchType: "Qualifier 1", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: third, teamBId: fourth, matchType: "Eliminator", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Qualifier 2", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Final", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null });

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

async function updateTournamentStats(tournamentId, performanceArray) {
    for(let perf of performanceArray) {
        let existing = await db.playerStats.where({ tournamentId, playerId: perf.playerId }).first();
        if(!existing) existing = { tournamentId, playerId: perf.playerId, runs:0, balls:0, wickets:0, runsConceded:0, oversBowled:0, highestScore:0, bestWickets:0 };
        if(perf.type === 'bat') {
            existing.runs += perf.runs;
            existing.balls += perf.balls;
            if(perf.runs > existing.highestScore) existing.highestScore = perf.runs;
        }
        if(perf.type === 'bowl') {
            existing.wickets += perf.wickets;
            existing.runsConceded += perf.runsConc;
            existing.oversBowled += perf.overs;
            if(perf.wickets > existing.bestWickets) existing.bestWickets = perf.wickets;
        }
        await db.playerStats.put(existing);
    }
}

// ---------- MATCH UI WITH DRAFT & REMATCH ----------
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
        let rematchBtn = m.status === 'completed' ? `<button class="rematch-btn" onclick="event.stopPropagation(); rematchMatch(${m.id})">🔄 Rematch</button>` : '';
        html += `<div class="match-item" onclick="openScorecardForMatch(${m.id})">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong>${teamAName} vs ${teamBName}</strong>
                        <div><span class="badge">${m.matchType || 'League'}</span> ${rematchBtn}</div>
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
    const newMatchId = await db.matches.add({
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
        battingFirst: null
    });
    Swal.fire("Rematch created! You can now enter the new match.");
    await refreshAllPanels();
}

// ---------- DRAFT SAVE & RESTORE ----------
async function saveDraft(matchId) {
    const match = await db.matches.get(matchId);
    if(!match || match.status === 'completed') return false;
    // Collect all input values from the scorecard form
    const container = document.getElementById('inningsContainer');
    const inputs = container.querySelectorAll('input');
    const draftData = {};
    inputs.forEach(inp => {
        draftData[inp.id || inp.className + '_' + inp.name] = inp.value;
    });
    // Also store toss info if already set
    const tossInfoDiv = document.getElementById('tossInfo');
    draftData.tossHtml = tossInfoDiv.innerHTML;
    await db.matchDrafts.put({ matchId, draftData, updatedAt: new Date() });
    return true;
}

async function restoreDraft(matchId) {
    const draft = await db.matchDrafts.where('matchId').equals(matchId).first();
    if(!draft) return false;
    const container = document.getElementById('inningsContainer');
    const inputs = container.querySelectorAll('input');
    inputs.forEach(inp => {
        const key = inp.id || inp.className + '_' + inp.name;
        if(draft.draftData[key] !== undefined) inp.value = draft.draftData[key];
    });
    const tossInfoDiv = document.getElementById('tossInfo');
    if(draft.draftData.tossHtml) tossInfoDiv.innerHTML = draft.draftData.tossHtml;
    return true;
}

async function clearDraft(matchId) {
    await db.matchDrafts.where('matchId').equals(matchId).delete();
}

// ---------- SCORECARD MODAL (with draft support) ----------
async function openScorecardForMatch(matchId) {
    let match = await db.matches.get(matchId);
    if(!match) return;
    if(match.status === 'completed') {
        Swal.fire("Match already completed", "You cannot edit a finished match.", "info");
        return;
    }
    document.getElementById('currentMatchId').value = matchId;
    document.getElementById('modalMatchTitle').innerHTML = `Enter Scorecard: ${(await db.teams.get(match.teamAId))?.name} vs ${(await db.teams.get(match.teamBId))?.name}`;
    
    if(match.tossWinner && match.tossDecision) {
        let teamDict = Object.fromEntries((await db.teams.toArray()).map(t=>[t.id, t]));
        document.getElementById('tossInfo').innerHTML = `<div class="badge" style="background:#ffe0b5;">Toss: ${teamDict[match.tossWinner]?.name} won and chose to ${match.tossDecision} first.</div>`;
        await loadScorecardForm(match, match.battingFirst);
        await restoreDraft(matchId);  // restore any saved draft
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
        if(!tossWinnerId) { closeScorecardModal(); return; }
        const { value: decision } = await Swal.fire({
            title: 'Decision',
            text: `${teams.find(t=>t.id==tossWinnerId)?.name} won toss. Choose to:`,
            input: 'select',
            inputOptions: { 'bat': 'Bat First', 'bowl': 'Bowl First' }
        });
        if(!decision) { closeScorecardModal(); return; }
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
        ${firstBatPlayers.map(p => `<div style="display:flex; gap:8px; margin-bottom:6px;"><span style="width:120px;">${p.name}</span><input type="number" placeholder="Runs" class="runs_${firstBatTeam.id}_${p.id}" style="width:70px;"><input type="number" placeholder="Balls" class="balls_${firstBatTeam.id}_${p.id}" style="width:70px;"></div>`).join('')}
        <h4>🎯 Bowling (${firstBowlingTeam.name})</h4>
        ${firstBowlPlayers.map(p => `<div><span>${p.name}</span> <input type="number" placeholder="Overs (max 20)" class="overs_${firstBowlingTeam.id}_${p.id}" step="0.1" min="0" max="20" style="width:70px;"> <input type="number" placeholder="Runs" class="runsConc_${firstBowlingTeam.id}_${p.id}" style="width:70px;"> <input type="number" placeholder="Wickets" class="wickets_${firstBowlingTeam.id}_${p.id}" style="width:70px;"></div>`).join('')}
        <div><label>Extras</label><input type="number" id="extras1" value="0"></div>
        </div>
        <div class="innings-block"><h4>🏏 Innings 2: ${secondBatTeam.name} Batting</h4>
        ${secondBatPlayers.map(p => `<div style="display:flex; gap:8px;"><span style="width:120px;">${p.name}</span><input type="number" placeholder="Runs" class="runs_${secondBatTeam.id}_${p.id}" style="width:70px;"><input type="number" placeholder="Balls" class="balls_${secondBatTeam.id}_${p.id}" style="width:70px;"></div>`).join('')}
        <h4>🎯 Bowling (${secondBowlPlayers[0]?.teamId ? (secondBowlPlayers[0].teamId === teamA.id ? teamA.name : teamB.name) : ''})</h4>
        ${secondBowlPlayers.map(p => `<div><span>${p.name}</span> <input type="number" placeholder="Overs (max 20)" class="overs_${secondBowlPlayers[0]?.teamId}_${p.id}" step="0.1" min="0" max="20" style="width:70px;"> <input type="number" placeholder="Runs" class="runsConc_${secondBowlPlayers[0]?.teamId}_${p.id}" style="width:70px;"> <input type="number" placeholder="Wickets" class="wickets_${secondBowlPlayers[0]?.teamId}_${p.id}" style="width:70px;"></div>`).join('')}
        <div><label>Extras</label><input type="number" id="extras2" value="0"></div>
        </div>`;
}

window.closeScorecardModal = () => {
    document.getElementById('scorecardModal').classList.remove('active');
    document.getElementById('currentMatchId').value = '';
};

// Pause button handler
document.getElementById('pauseMatchBtn')?.addEventListener('click', async () => {
    const matchId = parseInt(document.getElementById('currentMatchId').value);
    if(!matchId) return;
    await saveDraft(matchId);
    Swal.fire("Draft saved!", "You can resume this match later.", "success");
    closeScorecardModal();
});

// Complete match submission (with draft deletion)
document.getElementById('scorecardForm').onsubmit = async (e) => {
    e.preventDefault();
    let matchId = parseInt(document.getElementById('currentMatchId').value);
    let match = await db.matches.get(matchId);
    if(!match || match.status === 'completed') { Swal.fire("Invalid or already completed"); closeScorecardModal(); return; }

    let teamA = match.teamAId, teamB = match.teamBId;
    let battingFirstId = match.battingFirst;
    if(!battingFirstId) { Swal.fire("Toss not decided"); return; }

    let playersA = await db.players.where('teamId').equals(teamA).toArray();
    let playersB = await db.players.where('teamId').equals(teamB).toArray();

    let inningsData = { teamARuns:0, teamAOver:0, teamBRuns:0, teamBOver:0 };
    let statsUpdates = [];

    let firstBatTeamId = battingFirstId;
    let firstBowlTeamId = firstBatTeamId === teamA ? teamB : teamA;
    let firstBatPlayersList = firstBatTeamId === teamA ? playersA : playersB;
    let firstBowlPlayersList = firstBowlTeamId === teamA ? playersA : playersB;

    let totalRuns1 = 0, totalOvers1 = 0;
    for(let p of firstBatPlayersList) {
        let runs = parseInt(document.querySelector(`.runs_${firstBatTeamId}_${p.id}`)?.value) || 0;
        let balls = parseInt(document.querySelector(`.balls_${firstBatTeamId}_${p.id}`)?.value) || 0;
        totalRuns1 += runs;
        statsUpdates.push({ playerId: p.id, runs, balls, type: 'bat' });
    }
    for(let p of firstBowlPlayersList) {
        let wickets = parseInt(document.querySelector(`.wickets_${firstBowlTeamId}_${p.id}`)?.value) || 0;
        let runsConc = parseInt(document.querySelector(`.runsConc_${firstBowlTeamId}_${p.id}`)?.value) || 0;
        let overs = parseFloat(document.querySelector(`.overs_${firstBowlTeamId}_${p.id}`)?.value) || 0;
        if(overs > 20) { Swal.fire(`Overs cannot exceed 20 for ${p.name}`); return; }
        totalOvers1 += overs;
        statsUpdates.push({ playerId: p.id, wickets, runsConc, overs, type: 'bowl' });
    }
    let extras1 = parseInt(document.getElementById('extras1')?.value) || 0;
    totalRuns1 += extras1;
    if(firstBatTeamId === teamA) { inningsData.teamARuns = totalRuns1; inningsData.teamAOver = totalOvers1; }
    else { inningsData.teamBRuns = totalRuns1; inningsData.teamBOver = totalOvers1; }

    let secondBatTeamId = firstBatTeamId === teamA ? teamB : teamA;
    let secondBowlTeamId = secondBatTeamId === teamA ? teamB : teamA;
    let secondBatPlayersList = secondBatTeamId === teamA ? playersA : playersB;
    let secondBowlPlayersList = secondBowlTeamId === teamA ? playersA : playersB;

    let totalRuns2 = 0, totalOvers2 = 0;
    for(let p of secondBatPlayersList) {
        let runs = parseInt(document.querySelector(`.runs_${secondBatTeamId}_${p.id}`)?.value) || 0;
        let balls = parseInt(document.querySelector(`.balls_${secondBatTeamId}_${p.id}`)?.value) || 0;
        totalRuns2 += runs;
        statsUpdates.push({ playerId: p.id, runs, balls, type: 'bat' });
    }
    for(let p of secondBowlPlayersList) {
        let wickets = parseInt(document.querySelector(`.wickets_${secondBowlTeamId}_${p.id}`)?.value) || 0;
        let runsConc = parseInt(document.querySelector(`.runsConc_${secondBowlTeamId}_${p.id}`)?.value) || 0;
        let overs = parseFloat(document.querySelector(`.overs_${secondBowlTeamId}_${p.id}`)?.value) || 0;
        if(overs > 20) { Swal.fire(`Overs cannot exceed 20 for ${p.name}`); return; }
        totalOvers2 += overs;
        statsUpdates.push({ playerId: p.id, wickets, runsConc, overs, type: 'bowl' });
    }
    let extras2 = parseInt(document.getElementById('extras2')?.value) || 0;
    totalRuns2 += extras2;
    if(secondBatTeamId === teamA) { inningsData.teamARuns = totalRuns2; inningsData.teamAOver = totalOvers2; }
    else { inningsData.teamBRuns = totalRuns2; inningsData.teamBOver = totalOvers2; }

    let winnerId = null;
    if(inningsData.teamARuns > inningsData.teamBRuns) winnerId = teamA;
    else if(inningsData.teamBRuns > inningsData.teamARuns) winnerId = teamB;

    match.status = "completed";
    match.winnerId = winnerId;
    match.inningsData = inningsData;
    await db.matches.update(matchId, match);
    await updateTournamentStats(currentTournamentId, statsUpdates);
    await clearDraft(matchId);  // remove any draft after completion
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
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: first, teamBId: second, matchType: "Qualifier 1", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: third, teamBId: fourth, matchType: "Eliminator", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Qualifier 2", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Final", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1, tossWinner: null, tossDecision: null, battingFirst: null });
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
        await db.matches.add({ tournamentId: currentTournamentId, teamAId: parseInt(ids.teamA), teamBId: parseInt(ids.teamB), matchType: "custom", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff:0, tossWinner: null, tossDecision: null, battingFirst: null });
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

// Make rematchMatch available globally
window.rematchMatch = rematchMatch;
