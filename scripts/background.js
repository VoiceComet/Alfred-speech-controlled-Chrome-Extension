/**
 * global state where all modules are reachable
 * @global
 */
var globalCommonState = new State("GlobalCommonState");
globalCommonState.init = function () {
	this.ableToCancel = false;
	
	this.actions = [];
	//add actions of modules
	for (var i = 0; i < modules.length; i++) {
		for (var j = 0; j < modules[i].actions.length; j++) {
			this.addAction(modules[i].actions[j]);
		}
	}
};

/** @global */
var activeState;
/** @global */
var activeTab;
/** @global */
var modules = [];
/** @global */
var globalStates = [];
/** @global */
var permissionGrounded = true;
/** @global */
var tabStates = [];
/** @global */
var tabCancelStacks = [];
/** @global */
var speechRecognitionControl = new SpeechRecognitionControl();


//global butler name for better access
/** @global */
var butlerName = "Alfred";
//get butler name from storage
chrome.storage.sync.get({
	speechAssistantName: "Alfred"
}, function(items) {
	//noinspection JSUnresolvedVariable
	butlerName = items.speechAssistantName;
});

var language = 'en';
var moduleLanguageJson = {};
var languageJson = {};
/**
 * set actual language and load language files
 */
function loadLanguage() {
	chrome.storage.sync.get({
		language: 'en'
	}, function(items) {
		language = items["language"];
		$.getJSON(chrome.extension.getURL("scripts/languages/" + items["language"] + "Modules.json"), function(json) {
			moduleLanguageJson = json;
		});
		$.getJSON(chrome.extension.getURL("scripts/languages/" + items["language"] + "Values.json"), function(json) {
			languageJson = json;
		});
	});
}
loadLanguage();


/**
 * function that is called after option changing
 * @param changes
 */
function optionChangeListener(changes) {
	for (var key in changes) {
		if (changes.hasOwnProperty(key)) {
			if (key == "speechAssistantName") {
				//refresh butler name after option change
				butlerName = changes[key].newValue;
			} else if (key == "speechAssistantVoice") {
				//say something with new voice
				say(translate("thisIsMyNewVoice"));
			} else if (key == "language") {
				loadLanguage();
			}
			//refresh active modules
			for (var i = 0; i < modules.length; i++) {
				if (key == modules[i].settingName) {
					modules[i].active = changes[key].newValue;
					break;
				}
			}
		}
	}
}
chrome.storage.onChanged.addListener(optionChangeListener);

//get active tab
chrome.tabs.query({active:true, currentWindow:true}, function (tabs) {
	if (tabs.length > 0) {
		activeTab = tabs[0].id;
	}
});


/**
 * add a module to this extension
 * @param {Module} module - Module Object
 * @global
 */
function addModule(module) {
	module.init();
	modules.push(module);
}

/**
 * add a state to global states
 * @param {State} state - State Object
 * @global
 */
function registerGlobalState(state) {
	globalStates.push(state);
}

/**
 * get a state from global states with given name
 * @param {String} internalName - internal name of State object
 * @global
 */
function getGlobalState(internalName) {
	for (var i = 0; i < globalStates.length; i++) {
		if (globalStates[i].internalName == internalName) {
			return globalStates[i];
		}
	}
	return null
}

/**
 * get state that should run after a cancel action
 * @global
 */
function getNextCancelState() {
	if (typeof tabCancelStacks[activeTab] === 'undefined') {
		tabCancelStacks[activeTab] = [];
	}

	if (tabCancelStacks[activeTab].length > 0) {
		var lastPos = tabCancelStacks[activeTab].length - 1;
		var newState = tabCancelStacks[activeTab][lastPos];
		tabCancelStacks[activeTab].splice(lastPos, 1);
		return newState;
	}
	console.error("cancel failed: stack is empty", tabCancelStacks[activeTab]);
	return null;
}

/**
 * change the active state
 * @param {State} newState - new State
 * @param {Boolean} [cancelStack=true] - true, if the cancel stack should be filled
 * @global
 */
function changeActiveState(newState, cancelStack) {
	if (newState == null) {
		console.error("change active state to null state is not possible", newState);
		return;
	}
	if (typeof tabCancelStacks[activeTab] === 'undefined') {
		tabCancelStacks[activeTab] = [];
	}
	if (typeof cancelStack === 'undefined' || cancelStack === true) {
		if (activeState != null) {
			if (tabCancelStacks[activeTab].length > 0) {
				//push to stack only if the last one is not the same state
				var lastPos = tabCancelStacks[activeTab].length - 1;
				var lastState = tabCancelStacks[activeTab][lastPos];
				if (lastState.internalName == newState.internalName) {
					//come to the last state of stack because of a circle, remove
					tabCancelStacks[activeTab].splice(lastPos, 1);
				} else if (newState.internalName != activeState.internalName) {
					//otherwise if it is different to active state, add to stack
					if (activeState.accessibleWithCancelAction)
						tabCancelStacks[activeTab].push(activeState);
				}
			} else {
				if (activeState.accessibleWithCancelAction)
					tabCancelStacks[activeTab].push(activeState);
			}
		}
	}
	speechRecognitionControl.stopSpeechRecognition();
	var oldState = activeState;
	activeState = newState;
	tabStates[activeTab] = activeState;
	console.info("run " + activeState.internalName + " (old: " + ((oldState != null) ? oldState.internalName : "null") + ")");
	activeState.run();
	speechRecognitionControl.startSpeechRecognition();
}

/**
 * change the active tab
 * @param {Number} newTabId - new tab id
 * @global
 */
function changeActiveTab(newTabId) {
	activeTab = newTabId;
	changeActiveState(tabStates[activeTab], false);
}


//add listener to browser action
//noinspection JSUnusedLocalSymbols
/**
 * is called when the browser action button is clicked
 * @param {chrome.tabs.Tab} tab
 */
function browserAction(tab) {
	speechRecognitionControl.switchRecognizing();
}
chrome.browserAction.onClicked.addListener(browserAction);

/**
 * activate the correct state of this tab
 * @param {Object} activeInfo
 */
function tabActivated(activeInfo) {
	if (!(activeInfo.tabId in tabStates)) {
		tabStates[activeInfo.tabId] = globalCommonState;
	} else {
		resizeUI();
	}
	changeActiveTab(activeInfo.tabId);
}
chrome.tabs.onActivated.addListener(tabActivated);


/**
 * remove remembered state if tab is closed
 * @param {Number} tabId
 */
function tabRemoved(tabId) {
	if (tabId in tabStates) {
		delete tabStates[tabId];
	}
}
chrome.tabs.onRemoved.addListener(tabRemoved);


/**
 * resizing ui in dependence to zoom level
 */
function resizeUI() {
	chrome.tabs.query({active:true, currentWindow:true}, function (tabs) {
		if (tabs.length > 0) {
			chrome.tabs.getZoom(tabs[0].id, function(zoomFactor) {
				callContentScriptMethod("setZoomFactor", {"zoomFactor":zoomFactor});
				//chrome.tabs.sendMessage(tabs[0].id, {callFunction: "setZoomFactor", params: {"zoomFactor":zoomFactor}});
			});
		}
	});
}
chrome.tabs.onZoomChange.addListener(resizeUI);
chrome.tabs.onUpdated.addListener(resizeUI);

/**
 * listener that checks if a tab is hand reloaded or a link is clicked by user
 * @param {Number} tabId
 * @param {Object} changeInfo
 */
function checkCorrectState(tabId, changeInfo) {
	if (changeInfo.hasOwnProperty("status") && changeInfo.status == "loading") {
		if (tabId == activeTab && activeState != globalCommonState) {
			//stop recognition
			changeActiveState(globalCommonState);
		} else if (tabStates[tabId] != globalCommonState) {
			tabStates[tabId] = globalCommonState;
		}
	}
}
chrome.tabs.onUpdated.addListener(checkCorrectState);


window.addEventListener("load", function() {
	if (!('webkitSpeechRecognition' in window)) {
		console.error("webkitSpeechRecognition not available.");
		alert("webkitSpeechRecognition not available.");
	} else {
		changeActiveState(globalCommonState);
	}
}, false);
