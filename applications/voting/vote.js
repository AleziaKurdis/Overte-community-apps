//
//  vote.js
//
//  App to simplify the tallying of votes for Community Meetings
//
//  Created by Armored Dragon, 2024.
//  Copyright 2024 Overte e.V.
//
//  Distributed under the Apache License, Version 2.0.
//  See the accompanying file LICENSE or http://www.apache.org/licenses/LICENSE-2.0.html

/* global Script Tablet Messages MyAvatar Uuid*/

// TODO: Documentation
// FIXME: Reset create_poll view when switching screens 
// FIXME: Handle ties: kill both of tied results
// FIXME: Handle ties: Last two standing are tied.

// FIXME: Host closes window does not return them to client view when applicable

(() => {
	"use strict";
	let tablet;
	let appButton;
	let active = false;
	const debug = false;

	let poll = {id: '', title: '', description: '', host: '', question: '', options: [], host_can_vote: false}; // The current poll
	let responses = {}; // All ballots received and to be used by the election function.
	let electionIterations = 0; // How many times the election function has been called to narrow down a candidate.
	let activePolls = []; // All active polls.

	const url = Script.resolvePath("./vote.qml");
	const myUuid = generateUUID(MyAvatar.sessionUUID);
	Messages.messageReceived.connect(receivedMessage);
	Messages.subscribe('ga-polls');

	tablet = Tablet.getTablet("com.highfidelity.interface.tablet.system");
	appButton = tablet.addButton({
		icon: Script.resolvePath("./img/icon_white.png"),
		activeIcon: Script.resolvePath("./img/icon_black.png"),
		text: "VOTE",
		isActive: active,
	});

	// When script ends, remove itself from tablet
	Script.scriptEnding.connect(function () {
		console.log("Shutting Down");
		tablet.removeButton(appButton);
		deletePoll(true);
	});

	AvatarList.avatarSessionChangedEvent.connect(_resetNetworking);

	// Overlay button toggle
	appButton.clicked.connect(toolbarButtonClicked);
	tablet.fromQml.connect(fromQML);
	tablet.screenChanged.connect(onTabletScreenChanged);

	function toolbarButtonClicked() {
		if (active) tablet.gotoHomeScreen();
		else tablet.loadQMLSource(url);

		active = !active;
		appButton.editProperties({
			isActive: active,
		});
	}

	function onTabletScreenChanged(type, newUrl) {
		if (url == newUrl) {
			active = true;

			// If we are connected to a poll already, repopulate the screen
			if (poll.id != '' && poll.host != myUuid) return joinPoll({id: poll.id});

			// If we are hosting a poll, switch the screen
			if (poll.id != '' && poll.host == myUuid) {
				return _emitEvent({type: "rehost", prompt: {question: poll.question, options: poll.options}});
			}

			// Request a list of active polls if we are not already in one
			if (poll.id == '') return getActivePolls();
		}
		else active = false;

		appButton.editProperties({
			isActive: active,
		});
	}

	// Functions

	// Get a list of active polls
	function getActivePolls() {
		// Sends a message to all hosts to send a list of their polls
		Messages.sendMessage('ga-polls', JSON.stringify({type: "populate"}));
	}

	// Create a new poll for others to join
	function createPoll(pollInformation) { 
		console.log("Creating a new poll");
		// Check if we are already hosting a poll
		if (poll.id != '') return;

		// Set our active poll data
		poll.id = generateUUID();
		poll.host = myUuid;
		poll.title = pollInformation.title;
		poll.description = pollInformation.description;
		console.log(`Active poll set as:\nid:${poll.id}\ntitle:${poll.title}\ndescription:${poll.description}`);
		responses = {}; // Clear any lingering responses

		// Send message to all clients
		Messages.sendMessage("ga-polls", JSON.stringify({type: "active_poll", poll: poll}));
		console.log("Broadcasted poll to server");

		// Subscribe to our own messages
		Messages.subscribe(poll.id);

		// Update the UI screen
		_emitEvent({type: "create_poll"});
	}

	// Closes the poll and return to the main menu
	function deletePoll(bypassPrompt){
		// Check to see if we are hosting the poll
		if (poll.host != myUuid) return; // We are not the host of this poll

		// We are in a poll
		if (poll.id == '') return;

		// Confirm to user if they want to close the poll
		if (!bypassPrompt) {
			var answer = Window.confirm('Are you sure you want to close the poll?')
			if (!answer) return;
		}

		console.log("Closing active poll");

		// Submit the termination message to all clients
		Messages.sendMessage("ga-polls", JSON.stringify({type: "close_poll", poll: {id: poll.id}}));

		// Update the UI screen
		_emitEvent({type: "close_poll", poll: {id: poll.id}, change_page: true});

		// Clear our active poll data
		_resetNetworking();
	}

	// Join an existing poll hosted by another user
	function joinPoll(pollToJoin){
		// TODO: Check if poll even exists

		// Leave poll if already connected to one
		leavePoll(); 

		// Save the poll information
		poll = pollToJoin;

		// Subscribe to message mixer for poll information
		Messages.subscribe(pollToJoin.id);

		// Send join notice to server. This will cause the host to (re)emit the current poll to the server 
		Messages.sendMessage(pollToJoin.id, JSON.stringify({type: "join"}));

		// Log the successful join
		console.log(`Successfully joined ${poll.id}`);
	}

	// Leave a poll hosted by another user
	function leavePoll() { 
		if (!poll.id) return; // No poll to leave

		let pollToLeave = poll.id;

		// Clear poll
		_resetNetworking();

		console.log(`Successfully left ${pollToLeave}`);
	}

	// Cast a vote on a poll
	function castVote(event) {
		console.log(`Casting vote to ${poll.id}`);

		// Check if poll is valid
		if (poll == undefined || poll.id == '') return;

		// Send vote to users in poll
		Messages.sendMessage(poll.id, JSON.stringify({type: "vote", ballot: event.ballot, uuid: myUuid}));
	}

	// Emit the prompt question and options to the server
	function emitPrompt(){
		if (poll.host != myUuid) return; // We are not the host of this poll

		console.log(`Emitting prompt`);
		Messages.sendMessage(poll.id, JSON.stringify({type: "poll_prompt", prompt: {question: poll.question, options: poll.options}}));
	}

	// Take the gathered responses and preform the election
	// TODO: Simplify logging of critical information
	// FIXME: Recursive function call
	function preformElection(){
		let firstVotes = []; // List of first choices from every ballot
		let voteResults = {}; // Object that stores the total amount of votes each candidate gets
	
		// Don't run election if we don't have any votes.
		if (Object.keys(responses).length == 0) return; 
	
		// Go though each vote received and get the most preferred candidate per ballot.
		Object.keys(responses).forEach((key) => {
			let uuid = key;
			let vote = responses[uuid];
	
			// Assign first vote to new array
			firstVotes.push(vote[0]);
		});
	
		// Go through each first choice and increment the total amount of votes per candidate.
		for (let i = 0; i < firstVotes.length; i++) {
			let candidate = firstVotes[i];
	
			// Check if firstVotes index exists
			if (!candidate) candidate = -1; // If we have received a "no-vote", just assign -1
	
			// Create voteResults index if it does not exist
			if (!voteResults[candidate]) voteResults[candidate] = 0;
	
			// Increment value for each vote
			voteResults[candidate]++
		}
	
		const totalVotes = Object.keys(responses).length; // Total votes to expect to be counted.
		const majority = Math.floor(totalVotes / 2); // Minimum value to be considered a majority
	
		const sortedArray = Object.entries(voteResults).sort((a, b) => b[1] - a[1]);
		let sortedObject = [];
		for (const [key, value] of sortedArray) {
			sortedObject.push({ [key]: value });
		}

		console.log(`Iteration Votes: ${JSON.stringify(sortedObject, null, 2)}`);
	
		// Check the most voted for option to see if it makes up over 50% of votes
		// NOTE: Has to be *over* 50%.
		if (sortedObject[0][Object.keys(sortedObject[0])[0]] > majority) {
			let winnerName = Object.keys(sortedObject[0])[0];
			if (winnerName == '-1') winnerName = "No vote";
			Messages.sendMessage(poll.id, JSON.stringify({type: "poll_winner", winner: winnerName, rounds: electionIterations, votesCounted: totalVotes}));
			console.log(`\nWinner: ${winnerName}\nElection rounds: ${electionIterations}\nVotes counted: ${totalVotes}`);
			responses = {};
			return; // Winner was selected. We are done!
		}; 
	
		// If there is not a majority vote, remove the least popular candidate and call preformElection() again
		let leastPopularIndex = sortedObject.length - 1;
		let leastPopular = Object.keys(sortedObject[leastPopularIndex])[0];

		// Check to see if least popular is "-1"/"no-vote"
		if (leastPopular === "-1") {
			leastPopularIndex--;
			leastPopular = Object.keys(sortedObject[leastPopularIndex])[0]; // Get the real leastPopular candidate
		}
	
		console.log(`Removing least popular: ${leastPopular}`);
	
		// Go into each vote and delete the selected least popular candidate
		Object.keys(responses).forEach((uuid) => {
			// Remove the least popular candidate from each vote.
			if (responses[uuid].indexOf(leastPopular) != -1) responses[uuid].splice(responses[uuid].indexOf(leastPopular), 1);
			console.log(responses[uuid]);
		});
	
		// Update statistics
		electionIterations++; 
	
		// Run again
		preformElection();
	}

	// Create a UUID or turn an existing UUID into a string
	function generateUUID(existingUuid){
		if (!existingUuid) existingUuid = Uuid.generate(); // Generate standard UUID

		existingUuid = Uuid.toString(existingUuid); // Scripts way to turn it into a string
		return existingUuid.replace(/[{}]/g, ''); // Remove '{' and '}' from UUID string >:(
	}

	function _debugDummyBallot() {
		if (!debug) return; // Just incase...
		let ballot = getRandomOrder(...poll.options);

		const indexToRemove = Math.floor(Math.random() * ballot.length);
		ballot.splice(indexToRemove, ballot.length - indexToRemove);

		const responsesKeyName = Object.keys(responses).length.toString();
		responses[responsesKeyName] = ballot;

		function getRandomOrder(...words) {
			for (let i = words.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[words[i], words[j]] = [words[j], words[i]];
			}

			return words;
		}
	}

	// Reset application "networking" information to default values
	function _resetNetworking(){
		if (poll.id) Messages.unsubscribe(poll.id);

		poll = {id: '', title: '', description: '', host: '', question: '', options: [], host_can_vote: false}; 
		responses = {};
		electionIterations = 0; 
		activePolls = []; 
	}

	function _emitSound(type){
		switch (type) {
			case "new_prompt":
				const newPollSound = SoundCache.getSound(Script.resolvePath("./sound/new_vote.mp3"))
				Audio.playSystemSound(newPollSound, {volume: 0.5});
				break;
		}
	}

	// Communication
	function fromQML(event) {
		console.log(`New QML event:\n${JSON.stringify(event)}`);
		
		switch (event.type) {
		case "create_poll":
			createPoll(event.poll);
			break;
		case "join_poll":
			joinPoll(event.poll);
			break;
		case "cast_vote":
			castVote(event);
			break;
		case "close_poll":
			deletePoll();
			break;
		case "prompt":
			poll.question = event.prompt.question;
			poll.options = event.prompt.options;
			poll.host_can_vote = event.host_can_vote
			emitPrompt();
			break;
		case "run_election":
			// Debug: Create a lot of fake ballots
			if (debug) {
				for (let i = 0; i < 25; ++i) {
					_debugDummyBallot();
				}
			}

			electionIterations = 0;
			preformElection();
			break;
		}
	}
	/**
	 * Emit a packet to the HTML front end. Easy communication!
	 * @param {Object} packet - The Object packet to emit to the HTML
	 * @param {("create_poll"|"initial_settings")} packet.type - The type of packet it is
	 */
	function _emitEvent(packet = { type: "" }) {
		tablet.sendToQml(packet);
	}

	function receivedMessage(channel, message){
		// Not for us, ignore!
		if (channel !== 'ga-polls' && channel !== poll.id) return;

		console.log(`Received message on ${channel} from server:\n${JSON.stringify(message)}\n`);

		message = JSON.parse(message);

		switch (channel) {
		case "ga-polls":
			// Received a request to see our poll
			if (message.type == "populate") {
				// Send our poll information to the server if we are hosting it
				if (poll.host == myUuid) {
					Messages.sendMessage("ga-polls", JSON.stringify({type: "active_poll", poll: poll}));
				}
			}

			// Received an active poll 
			if (message.type == "active_poll") {
				if (poll.id != '') return; // We are in a poll, don't populate the list

				if (activePolls.indexOf(message.poll.id) != -1) return; // We already have that poll in the list

				_emitEvent({type: "new_poll", poll: message.poll});
				activePolls.push(message.poll.id);
			}

			// Polls closed :)
			if (message.type == "close_poll") { 
				var isOurPoll = poll.id == message.poll.id;

				// Tell UI to close poll
				_emitEvent({type: "close_poll", change_page: isOurPoll, poll: {id: message.poll.id}});

				// Unregister self from poll
				if (isOurPoll) leavePoll();
				activePolls.splice(activePolls.indexOf(message.poll.id), 1); // Remove from active list
			}

			break;
		case poll.id:
			// Received poll request
			if (message.type == "join") {
				emitPrompt();
			}

			// Received poll information
			if (message.type == "poll_prompt") {
				console.log(`Prompt:\n ${JSON.stringify(message.prompt)}`);

				// TODO: This is still silly. Try using UUIDs per prompt and check if we are answering the same question by id?
				// Don't recreate the prompt if we already have the matching question
				if (message.prompt.question == poll.question && !poll.host_can_vote) return;

				// Play sound for new poll
				_emitSound("new_prompt");

				_emitEvent({type: "poll_prompt", prompt: message.prompt});

				poll.question = message.prompt.question;
			}

			if (message.type == "vote_count") {
				_emitEvent({type: "received_vote", voteCount: message.voteCount});
			}

			// Received a ballot 
			if (message.type == "vote") {
				// Check if we are the host
				if (poll.host != myUuid) return;

				// Record the ballot
				responses[message.uuid] = message.ballot;

				// Emit a echo so the voter knows we have received it
				// TODO:

				// Broadcast the updated count to all clients
				Messages.sendMessage(poll.id, JSON.stringify({type: "vote_count", voteCount: Object.keys(responses).length}));
			}

			// Winner was broadcasted
			if (message.type == "poll_winner") {
				_emitEvent({type: "poll_winner", winner: message.winner, rounds: message.rounds, votesCounted: message.votesCounted});
			}

		}

	}
})();