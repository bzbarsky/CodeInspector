/* vim:set ts=2 sw=2 sts=2 et: */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Style Editor code.
 *
 * The Initial Developer of the Original Code is Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Brian Hackett <bhackett@mozilla.com> (original author)
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";

const EXPORTED_SYMBOLS = ["CodeInspectorChrome"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("chrome://CodeInspector/content/AdaptiveSplitView.jsm");
Cu.import("chrome://CodeInspector/content/Coverage.jsm");
Cu.import("chrome://CodeInspector/content/StyleEditorUtil.jsm");

function jsdump(str)
{
  Cc['@mozilla.org/consoleservice;1']
            .getService(Components.interfaces.nsIConsoleService)
            .logStringMessage(str);
}

function htmlEscape(str)
{
  str = str.replace(/\&/g, '&amp;');
  str = str.replace(/\</g, '&lt;');
  str = str.replace(/\>/g, '&gt;');
  return str;
}

var metricNames = [
    "mjitHits",
    "mjitStubs",
    "mjitCode",
    "mjitPics"
];

// Get a heuristic measurement of the amount of JIT activity for a script or
// opcode, with a heavy penalty for stub calls performed.
function jitActivity(v) {
  var stubs = v.mjitStubs || 0;
  var code = v.mjitCode || 0;
  var pics = v.mjitPics || 0;
  return (stubs * 100) + code + pics;
}

function activityColor(fraction) {
  // get an rgb color for fraction. 1.0 should return rgb(255,0,0), 0.0 should return rgb(10,0,0).
  var gb = 200 - ((fraction * 200) | 0);
  return "rgb(255," + gb + "," + gb + ")";
}

const ACTIVITY_THRESHOLD = .01;

const SCRIPT_TEMPLATE = "script";

const LOAD_ERROR = "load-error";
const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * CodeInspectorChrome constructor.
 *
 * The 'chrome' of the Coverage Tool is all the UI that populates and updates
 * the actual coverage reports.
 *
 * @param DOMElement aRoot
 *        Element that owns the chrome UI.
 * @param DOMWindow aContentWindow
 *        Optional content DOMWindow to attach to this chrome.
 *        Default: the currently active browser tab content window.
 */
function CodeInspectorChrome(aRoot, aContentWindow)
{
  assert(aRoot, "Argument 'aRoot' is required to initialize CodeInspectorChrome.");

  this._root = aRoot;
  this._document = this._root.ownerDocument;
  this._window = this._document.defaultView;

  this._coverage = null;
  this._listeners = []; // @see addChromeListener

  this._contentWindow = null;
  this._isContentAttached = false;

  let initializeUI = function (aEvent) {
    if (aEvent) {
      this._window.removeEventListener("load", initializeUI, false);
    }

    let viewRoot = this._root.parentNode.querySelector(".splitview-root");
    this._view = new AdaptiveSplitView(viewRoot);

    this._setupChrome();

    // attach to the content window
    this.contentWindow = aContentWindow || getCurrentBrowserTabContentWindow();
  }.bind(this);

  if (this._document.readyState == "complete") {
    initializeUI();
  } else {
    this._window.addEventListener("load", initializeUI, false);
  }
}

CodeInspectorChrome.prototype = {
  /**
   * Retrieve the content window attached to this chrome.
   *
   * @return DOMWindow
   */
  get contentWindow() this._contentWindow,

  /**
   * Set the content window attached to this chrome.
   * Content attach or detach events/notifications are triggered after the
   * operation is complete (possibly asynchronous if the content is not fully
   * loaded yet).
   *
   * @param DOMWindow aContentWindow
   * @see addChromeListener
   */
  set contentWindow(aContentWindow)
  {
    if (this._contentWindow == aContentWindow) {
      return; // no change
    }

    this._contentWindow = aContentWindow;

    if (!aContentWindow) {
      this._disableChrome();
      return;
    }

    /*
    let onContentUnload = function () {
      aContentWindow.removeEventListener("unload", onContentUnload, false);
      if (this.contentWindow == aContentWindow) {
        this.contentWindow = null; // detach
      }
    }.bind(this);
    aContentWindow.addEventListener("unload", onContentUnload, false);
    */

    if (aContentWindow.document.readyState == "complete") {
      this._populateChrome();
      return;
    } else {
      let onContentReady = function () {
        aContentWindow.removeEventListener("load", onContentReady, false);
        this._populateChrome();
      }.bind(this);
      aContentWindow.addEventListener("load", onContentReady, false);
    }
  },

  /**
   * Retrieve the content document attached to this chrome.
   *
   * @return DOMDocument
   */
  get contentDocument()
  {
    return this._contentWindow ? this._contentWindow.document : null;
  },

  /**
    * Retrieve whether the content has been attached and StyleEditor instances
    * exist for all of its stylesheets.
    *
    * @return boolean
    * @see addChromeListener
    */
  get isContentAttached() this._isContentAttached,

  /**
   * Add a listener for CodeInspectorChrome events.
   *
   * The listener implements ICodeInspectorChromeListener := {
   *   onContentAttach:        Called when a content window has been attached.
   *                           Arguments: (CodeInspectorChrome aChrome)
   *                           @see contentWindow
   *
   *   onContentDetach:        Called when the content window has been detached.
   *                           Arguments: (CodeInspectorChrome aChrome)
   *                           @see contentWindow
   *
   *   onScriptAdded:          Called when a script has been added to the UI.
   *                           Arguments (CodeInspectorChrome aChrome,
   *                                      string scriptUri)
   * }
   *
   * All listener methods are optional.
   *
   * @param IStyleEditorChromeListener aListener
   * @see removeChromeListener
   */
  addChromeListener: function CC_addChromeListener(aListener)
  {
    this._listeners.push(aListener);
  },

  /**
   * Remove a listener for Chrome events from the current list of listeners.
   *
   * @param IStyleEditorChromeListener aListener
   * @see addChromeListener
   */
  removeChromeListener: function CC_removeChromeListener(aListener)
  {
    let index = this._listeners.indexOf(aListener);
    if (index != -1) {
      this._listeners.splice(index, 1);
    }
  },

  /**
   * Trigger named handlers in StyleEditorChrome listeners.
   *
   * @param string aName
   *        Name of the event to trigger.
   * @param Array aArgs
   *        Optional array of arguments to pass to the listener(s).
   * @see addActionListener
   */
  _triggerChromeListeners: function CC__triggerChromeListeners(aName, aArgs)
  {
    // insert the origin Chrome instance as first argument
    if (!aArgs) {
      aArgs = [this];
    } else {
      aArgs.unshift(this);
    }

    // trigger all listeners that have this named handler
    for (let i = 0; i < this._listeners.length; ++i) {
      let listener = this._listeners[i];
      let handler = listener["on" + aName];
      if (handler) {
        handler.apply(listener, aArgs);
      }
    }
  },

  /**
   * Set up the chrome UI. Install event listeners and so on.
   */
  _setupChrome: function CC__setupChrome()
  {
    // wire up UI elements
    wire(this._view.rootElement, ".coverage-tool-trackButton", function onTrackButton() {
      this._dumpCoverageData();
    }.bind(this));
  },

  /**
   * Reset the chrome UI to an empty state.
   */
  _resetChrome: function CC__resetChrome()
  {
//FIXME:
    if (this._coverage) {
      this._coverage.removeListener(this);
    }
    this._coverage = null;

    this._view.removeAll();
  },

  /**
   * Populate the chrome UI according to the content document.
   *
   * @see StyleEditor._setupShadowStyleSheet
   */
  _populateChrome: function CC__populateChrome()
  {
    this._resetChrome();

    this._document.title = _("chromeWindowTitle",
          this.contentDocument.title || this.contentDocument.location.href);

    this._coverageData = {};
    this._coverage = new Coverage();
    this._coverage.addListener(this);

    this._triggerChromeListeners("ContentAttach");
  },

  /**
   * Disable all UI, effectively making editors read-only.
   * This is automatically called when no content window is attached.
   *
   * @see contentWindow
   */
  _disableChrome: function CC__disableChrome()
  {
    this._triggerChromeListeners("ContentDetach");
  },

  //FIXME:
  _signalError: function CC__signalError(aCode)
  {
    log("ERROR", aCode);
  },

  startProfiling: function ()
  {
    var startButton = this._document.getElementById("startProfiling");
    var stopButton = this._document.getElementById("stopProfiling");

    startButton.disabled = true;
    stopButton.disabled = false;

    var utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);
    utils.startPCCountProfiling();
  },

  stopProfiling: function()
  {
    var startButton = this._document.getElementById("startProfiling");
    var stopButton = this._document.getElementById("stopProfiling");

    startButton.disabled = false;
    stopButton.disabled = true;

    var utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);
    utils.stopPCCountProfiling();

    var count = utils.getPCCountScriptCount();
    var text = "";

    this.scripts = [];
    for (var i = 0; i < count; i++) {
      var json = utils.getPCCountScriptSummary(i);
      var summary = JSON.parse(json);
      summary.id = i;
      this.scripts.push(summary);
    }

    // initially sort the scripts by the amount of JIT activity.
    var activityScripts = this.scripts.sort(function (a,b) { return jitActivity(b) - jitActivity(a); });

    var maxActivity = jitActivity(activityScripts[0] || {});
    for (var i = 0; i < activityScripts.length; i++) {
      var summary = activityScripts[i];
      var fraction = jitActivity(summary) / maxActivity;
      if (fraction < ACTIVITY_THRESHOLD)
        continue;
      var color = activityColor(fraction);
      var toggle = "'document.toggleScript(" + summary.id + ")'";
      text += "<div class='scriptHeader'>";
      text += "<a href='#' onclick=" + toggle + " style='background-color:" + color + ";white-space:pre'>    </a>";
      text += "<a href='#' onclick=" + toggle + " class='scriptHeader'>";
      text += " " + htmlEscape(summary.name);
      text += "</a>";
      text += "</div>";
      text += "<div id='scriptTable" + summary.id + "'></div>";
    }

    this._document.toggleScript = this.toggleScript.bind(this);
    this._document.toggleOpcode = this.toggleOpcode.bind(this);

    var pane = this._document.getElementById("scriptPane");
    pane.innerHTML = text;
  },

  toggleScript: function(scriptIndex)
  {
    var element = this._document.getElementById("scriptTable" + scriptIndex);
    if (element.innerHTML) {
      element.innerHTML = "";
      return;
    }

    var utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);
    var json = utils.getPCCountScriptContents(scriptIndex);

    var contents = JSON.parse(json);

    var text = WalkScriptText.call(this, scriptIndex, contents);
    element.innerHTML = text;
  },

  toggleOpcode: function(scriptIndex, id)
  {
    var op = this.scripts[scriptIndex].opcodes[id];

    var selector = this._document.getElementById("selector_" + scriptIndex + "_" + id);
    var dropdown = this._document.getElementById("dropdown_" + scriptIndex + "_" + id);
    if (dropdown.innerHTML) {
      dropdown.style.paddingTop = "";
      dropdown.style.paddingBottom = "";
      dropdown.innerHTML = "";
      selector.className = op.underlined ? "opcodeInline" : "opcodeOOL";
      selector.style.backgroundColor = op.color;
      return;
    }

    selector.className = op.underlined ? "opcodeInlineSelected" : "opcodeOOLSelected";
    selector.style.backgroundColor = '#1E90FF';

    var text = "<a href='#' onclick='toggleOpcode(" + scriptIndex + "," + id + ")' class='opcodeDropdown'>";
    text += htmlEscape(op.text);
    text += "</a>";

    text += "<span class='metrics'> ::";

    for (var i = 0; i < metricNames.length; i++) {
      var name = metricNames[i];
      if (op[name])
        text += " " + name + ": " + op[name];
    }

    text += "</span>";

    dropdown.style.paddingTop = "4px";
    dropdown.style.paddingBottom = "4px";
    dropdown.innerHTML = text;
  }
};

function WalkScriptText(scriptIndex, contents)
{
  // split the script text into separate lines, annotating each line with
  // expression information in that line.

  var linesArray = contents.text.split('\n').map(function(v) { return {text:v, ops:[]} });

  var line = linesArray[0];
  var lineIndex = 0;
  var lineOffset = 0;  // starting offset of the current line

  var opcodes = {};

  // store opcodes on the CodeInspectorChrome for later use.
  this.scripts[scriptIndex].opcodes = opcodes;

  var maxActivity = 0;
  var opcodeArray = contents.opcodes || [];
  for (var i = 0; i < opcodeArray.length; i++) {
    var op = opcodeArray[i];
    opcodes[op.id] = op;
    var activity = jitActivity(op);
    if (activity > maxActivity)
      maxActivity = activity;
  }

  function addChildrenText(op, startOffset, endOffset, depth) {
    if (op.text && !op.hasAssignedLine) {
      line.ops.push(op);
      op.hasAssignedLine = true;
    }

    if (op.text && startOffset) {
      var len = op.text.length;
      while (startOffset + len <= endOffset) {
        if (line.text.substring(startOffset, startOffset + len) == op.text) {
          var fraction = jitActivity(op) / maxActivity;
          if (fraction >= ACTIVITY_THRESHOLD) {
            op.lineOffset = startOffset;
            op.lineDepth = depth++;
            op.color = activityColor(fraction);
          }
          endOffset = startOffset + len;
          break;
        }
        startOffset++;
      }
    }

    var children = op.children || [];
    for (var i = 0; i < children.length; i++) {
      var child = opcodes[children[i]];
      if (child)
        startOffset = addChildrenText(child, startOffset, endOffset, depth);
    }

    return endOffset;
  }

  var opcodeArray = contents.opcodes || [];
  for (var i = 0; i < opcodeArray.length; i++) {
    var op = opcodeArray[i];
    opcodes[op.id] = op;

    // track the encountered line for each opcode, to use in case the opcode is
    // orphaned and has no transitive parent with an offset.
    op.foundLine = line;

    // for opcodes with offsets into the script text, update the current line.
    if (op.offset) {
      while (op.offset < lineOffset) {
        line = linesArray[--lineIndex];
        lineOffset -= line.text.length + 1;
      }
      while (lineOffset + line.text.length < op.offset && lineIndex != linesArray.length - 1) {
        lineOffset += line.text.length + 1;
        line = linesArray[++lineIndex];
      }

      var startOffset = op.offset - lineOffset;
      var endOffset = op.text ? startOffset + op.text.length : line.text.length;
      addChildrenText(op, startOffset, endOffset, 0);
    }
  }

  // update op arrays on each line with any orphaned opcodes.
  for (var id in opcodes) {
    var op = opcodes[id];
    if (op.text && !op.hasAssignedLine) {
      var line = op.foundLine || lineArray[0];
      line.ops.push(op);
    }
  }

  var text = "<table class='codeDisplay' cellspacing='0' cellpadding='0'>";

  for (var i = 0; i < linesArray.length; i++) {
    var line = linesArray[i];

    text += "<tr><td class='code'>";
    text += htmlEscape(line.text);

    var underlinedArray = [];
    for (var depth = 0;; depth++) {
      var underlined = [];
      for (var j = 0; j < line.ops.length; j++) {
        var op = line.ops[j];
        if (op.lineDepth !== undefined && op.lineDepth == depth) {
          op.underlined = true;
          underlined.push(op);
        }
      }
      if (!underlined.length)
        break;
      underlinedArray.push(underlined);
    }

    var hasPrefix = false;
    for (var j = 0; j < line.ops.length; j++) {
      var op = line.ops[j];
      if (op.underlined)
        continue;
      var fraction = jitActivity(op) / maxActivity;
      if (fraction < ACTIVITY_THRESHOLD)
        continue;
      op.color = activityColor(fraction);
      if (!hasPrefix)
        text += "   ";
      hasPrefix = true;
      text += " <a href='#' onclick='toggleOpcode(" + scriptIndex + "," + op.id + ")' class='opcodeOOL'"
            + " style = 'background-color:" + op.color + "' id='selector_" + scriptIndex + "_" + op.id + "'>";
      text += htmlEscape(op.text);
      text += "</a>";
    }

    text += "</td></tr>\n";

    for (var j = 0; j < underlinedArray.length; j++) {
      var underlined = underlinedArray[j].sort(function (a,b) { return a.lineOffset > b.lineOffset; });

      text += "<tr><td class='underline'>";
      var offset = 0;
      for (var k = 0; k < underlined.length; k++) {
        var op = underlined[k];
        while (offset < op.lineOffset) {
          text += " ";
          offset++;
        }
        text += "<a href='#' onclick='toggleOpcode(" + scriptIndex + "," + op.id + ")' class='opcodeInline'"
              + " style = 'background-color:" + op.color + "' id='selector_" + scriptIndex + "_" + op.id + "'>";
        while (offset < op.lineOffset + op.text.length) {
          text += " ";
          offset++;
        }
        text += "</a>";
      }
      text += "</td></tr>";
    }

    // add empty <div> tags to hold dropdown information for each op.
    text += "<tr><td class='dropdown'>";
    for (var j = 0; j < line.ops.length; j++) {
      var op = line.ops[j];
      if (op.color)
        text += "<div id='dropdown_" + scriptIndex + "_" + op.id + "' class='dropdown'></div>";
    }
    text += "</td></tr>";
  }

  text += "</table>";
  return text;
}

