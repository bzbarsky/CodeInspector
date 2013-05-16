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
 *   Cedric Vivier <cedricv@neonux.com>
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

const EXPORTED_SYMBOLS = ["JITInspectorChrome"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("chrome://JITInspector/content/AdaptiveSplitView.jsm");
Cu.import("chrome://JITInspector/content/Coverage.jsm");
Cu.import("chrome://JITInspector/content/StyleEditorUtil.jsm");

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

function computeName(summary)
{
  // get the printed name for a script summary.
  var text = "";
  if (summary.name)
    text += summary.name + " : ";
  var file = summary.file.substring(0, 80);  // shorten long file paths
  text += file + " (line " + summary.line + ")";
  return text;
}

var metricNames = [
    "interp",
    "mjit",
    "mjit_calls",
    "mjit_code",
    "mjit_pics",
    "infer_mono",
    "infer_di",
    "infer_poly",
    "infer_barrier",
    "infer_nobarrier",
    "observe_undefined",
    "observe_null",
    "observe_boolean",
    "observe_int32",
    "observe_double",
    "observe_string",
    "observe_object",
    "id_int",
    "id_double",
    "id_other",
    "id_unknown",
    "elem_typed",
    "elem_packed",
    "elem_dense",
    "elem_other",
    "prop_static",
    "prop_definite",
    "prop_other",
    "arith_int",
    "arith_double",
    "arith_other",
    "arith_unknown"
];

function combineCounts(a, b)
{
  var props = Object.getOwnPropertyNames(a);
  for (var i = 0; i < props.length; i++) {
    var prop = props[i];
    var bprop = b[prop] || 0;
    b[prop] = bprop + a[prop];
  }
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
 * JITInspectorChrome constructor.
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
function JITInspectorChrome(aRoot, aContentWindow)
{
  assert(aRoot, "Argument 'aRoot' is required to initialize JITInspectorChrome.");

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

JITInspectorChrome.prototype = {
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
   * Add a listener for JITInspectorChrome events.
   *
   * The listener implements IJITInspectorChromeListener := {
   *   onContentAttach:        Called when a content window has been attached.
   *                           Arguments: (JITInspectorChrome aChrome)
   *                           @see contentWindow
   *
   *   onContentDetach:        Called when the content window has been detached.
   *                           Arguments: (JITInspectorChrome aChrome)
   *                           @see contentWindow
   *
   *   onScriptAdded:          Called when a script has been added to the UI.
   *                           Arguments (JITInspectorChrome aChrome,
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
    var clearButton = this._document.getElementById("clearProfiling");

    startButton.disabled = true;
    stopButton.disabled = false;
    clearButton.disabled = false;

    var utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);
    utils.startPCCountProfiling();
  },

  stopProfiling: function()
  {
    this.ionOpcodeTotals = this.ionOpcodeDisabled = null;

    var startButton = this._document.getElementById("startProfiling");
    var stopButton = this._document.getElementById("stopProfiling");
    var clearButton = this._document.getElementById("clearProfiling");

    startButton.disabled = false;
    stopButton.disabled = true;
    clearButton.disabled = false;

    var utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);
    utils.stopPCCountProfiling();

    var count = utils.getPCCountScriptCount();

    this.scripts = [];
    for (var i = 0; i < count; i++) {
      var json = utils.getPCCountScriptSummary(i);
      var summary = JSON.parse(json);
      summary.id = i;
      this.scripts.push(summary);
    }
    this.ionSummary = null;

    this.updateSelection();
  },

  clearProfiling: function()
  {
    var startButton = this._document.getElementById("startProfiling");
    var stopButton = this._document.getElementById("stopProfiling");
    var clearButton = this._document.getElementById("clearProfiling");

    startButton.disabled = false;
    stopButton.disabled = true;
    clearButton.disabled = true;

    var utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);
    utils.purgePCCounts();

    var pane = this._document.getElementById("scriptPane");
    pane.innerHTML = "No profiles to display.";
  },

  ignoreIonOpcode: function(op)
  {
    switch (op) {
    case "MoveGroup":
    case "OsiPoint":
    case "OsrEntry":
    case "OsrValue":
    case "Parameter":
    case "Start":
      return true;
    }
    return false;
  },

  computeIonOpcodeTotals: function()
  {
    this.ionOpcodeTotals = {};
    this.ionOpcodeDisabled = {};

    var utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);

    for (var i = 0; i < this.scripts.length; i++) {
      if (!this.scripts[i].totals.ion)
        continue;

      var json = utils.getPCCountScriptContents(i);
      var contents = JSON.parse(json);

      if (!contents.ion)
        continue;

      var scriptTotals = {};
      this.scripts[i].totals.ionOpcodeTotals = scriptTotals;

      for (var j = 0; j < contents.ion.length; j++) {
        var ion = contents.ion[j];

        for (var k = 0; k < ion.length; k++) {
          var block = ion[k];
          if (!block.hits)
            continue;

          var codeLines = block.code.split('\n');
          for (var codeIndex = 0; codeIndex < codeLines.length; codeIndex++) {
            var match;
            if (match = /\[([^\]]*)\]/.exec(codeLines[codeIndex])) {
              var opcode = match[1];
              if (this.ignoreIonOpcode(opcode))
                continue;
              if (!scriptTotals[opcode])
                scriptTotals[opcode] = 0;
              scriptTotals[opcode] += block.hits;
              if (!this.ionOpcodeTotals[opcode])
                this.ionOpcodeTotals[opcode] = 0;
              this.ionOpcodeTotals[opcode] += block.hits;
              jsdump("WHAT " + opcode + " " + block.hits);
            }
          }
        }
      }
    }
  },

  measureIonBlockActivity: function(block)
  {
    var total = 0;
    var codeLines = block.code.split('\n');
    for (var codeIndex = 0; codeIndex < codeLines.length; codeIndex++) {
      var match;
      if (match = /\[([^\]]*)\]/.exec(codeLines[codeIndex])) {
        var opcode = match[1];
        if (this.ignoreIonOpcode(opcode))
          continue;
        if (this.ionOpcodeDisabled[opcode])
          continue;
        total += block.hits
      }
    }
    return total;
  },

  toggleIonOpcode: function(opcode)
  {
    this.ionOpcodeDisabled[opcode] = !this.ionOpcodeDisabled[opcode];
    this.updateSelection();
  },

  toggleAllIonOpcodes: function(disabled)
  {
    for (var key in this.ionOpcodeTotals)
      this.ionOpcodeDisabled[key] = disabled;
    this.updateSelection();
  },

  updateSelection: function()
  {
    var viewSelection = this._document.getElementById("viewSelection");
    var selectedValue = viewSelection.options[viewSelection.selectedIndex].value;

    var measureActivity;
    if (selectedValue == "activity") {
      // Get a heuristic measurement of the amount of JIT activity for a script or
      // opcode, with a heavy penalty for stub calls performed.
      measureActivity = this.measureActivity = function (v) {
        var stubs = v.mjit_calls || 0;
        var code = v.mjit_code || 0;
        var pics = v.mjit_pics || 0;
        return (stubs * 100) + code + pics;
      };
    } else if (selectedValue == "ion") {
      if (!this.ionOpcodeTotals)
        this.computeIonOpcodeTotals();

      measureActivity = this.measureActivity = (function (v) {
        if (!v.ionOpcodeTotals)
          return 0;
        var total = 0;
        for (var key in this.ionOpcodeTotals) {
          if (!this.ionOpcodeDisabled[key])
            total += v.ionOpcodeTotals[key] || 0;
        }
        return total;
      }).bind(this);
    } else {
      // Measure the specific attribute chosen.
      measureActivity = this.measureActivity = function (v) {
        return v[selectedValue] || 0;
      };
    }

    var activityScripts = this.scripts.slice(0).sort(
      function (a,b) { return measureActivity(b.totals) - measureActivity(a.totals); }
    );

    var text = "";

    if (selectedValue == "ion") {
      text += "<div class='categoryHeader'>Ion Opcodes</div>";
      text += "<a href='#' onclick='document.toggleAllIonOpcodes(false)' class='ionSelect'>Select All</a>";
      text += "<a href='#' onclick='document.toggleAllIonOpcodes(true)' class='ionSelect'>Clear All</a>";
      text += "<br></br><br></br>";

      var opcodeList = [];
      for (var key in this.ionOpcodeTotals)
        opcodeList.push(key);
      opcodeList.sort(
        (function (a,b) { return this.ionOpcodeTotals[b] - this.ionOpcodeTotals[a]; }).bind(this)
      );

      var maxActivity = this.ionOpcodeTotals[opcodeList[0]] || 1;
      for (var i = 0; i < opcodeList.length; i++) {
        var opcode = opcodeList[i];
        var fraction = this.ionOpcodeTotals[opcode] / maxActivity;
        if (fraction < ACTIVITY_THRESHOLD)
          continue;

        var color = activityColor(fraction);

        var clasp = (this.ionOpcodeDisabled[opcode]) ? 'ionOpcodeDisabled' : 'ionOpcodeEnabled';

        var toggle = "'document.toggleIonOpcode(\"" + opcode + "\")'";
        text += "<div class='scriptHeader'>";
        text += "<a href='#' onclick=" + toggle + " style='background-color:" + color + ";white-space:pre'>    </a>";
        text += "<a href='#' onclick=" + toggle + " class='" + clasp + "'>";
        text += " " + htmlEscape(opcode);
        text += "</a>";
        text += "</div>";
      }

      text += "<div class='categoryHeader'>Scripts</div>";
    }

    var maxActivity = this.measureActivity(activityScripts[0].totals || {}) || 1;
    for (var i = 0; i < activityScripts.length; i++) {
      var summary = activityScripts[i];
      var fraction = measureActivity(summary.totals) / maxActivity;
      if (fraction < ACTIVITY_THRESHOLD && !summary.selected)
        continue;
      var color = activityColor(fraction);
      var toggle = "'document.toggleScript(" + summary.id + ")'";
      text += "<div class='scriptHeader'>";
      text += "<a href='#' onclick=" + toggle + " style='background-color:" + color + ";white-space:pre'>    </a>";
      text += "<a href='#' onclick=" + toggle + " class='scriptHeader'>";
      text += " " + htmlEscape(computeName(summary));
      text += "</a>";
      text += "</div>";
      text += "<div id='scriptTable" + summary.id + "'></div>";
    }

    this._document.toggleScript = this.toggleScript.bind(this);
    this._document.toggleOpcode = this.toggleOpcode.bind(this);
    this._document.toggleIonOpcode = this.toggleIonOpcode.bind(this);
    this._document.toggleAllIonOpcodes = this.toggleAllIonOpcodes.bind(this);

    var pane = this._document.getElementById("scriptPane");
    pane.innerHTML = text;

    var newMeasureIon = (selectedValue == "ion");
    if (newMeasureIon != this.measureIon) {
      this.measureIon = newMeasureIon;

      // Reset the selected opcodes for the script. Opcodes have different names
      // when showing Ion basic blocks vs. per-op information.
      for (var i = 0; i < activityScripts.length; i++)
        this.scripts[activityScripts[i].id].selectedOpcodes = null;
    }

    for (var i = 0; i < activityScripts.length; i++) {
      var summary = activityScripts[i];
      if (summary.selected)
        this.toggleScript(summary.id);
    }
  },

  toggleScript: function(scriptIndex)
  {
    var script = this.scripts[scriptIndex];

    var element = this._document.getElementById("scriptTable" + scriptIndex);
    if (element.innerHTML) {
      element.innerHTML = "";
      script.selected = false;
      return;
    }

    script.selected = true;

    var utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);
    var json = utils.getPCCountScriptContents(scriptIndex);
    var contents = JSON.parse(json);

    var fn = this.measureIon ? WalkScriptIon : WalkScriptText;
    var text = fn.call(this, scriptIndex, contents);
    element.innerHTML = text;

    var selected = script.selectedOpcodes;
    if (selected) {
      for (var i = 0; i < selected.length; i++)
        this.toggleOpcode(scriptIndex, selected[i]);
    }
  },

  toggleOpcode: function(scriptIndex, id)
  {
    var script = this.scripts[scriptIndex];
    var op = script.opcodes[id];

    var selector = this._document.getElementById("selector_" + scriptIndex + "_" + id);
    var dropdown = this._document.getElementById("dropdown_" + scriptIndex + "_" + id);

    if (!selector || !dropdown)
      return;

    if (dropdown.innerHTML) {
      dropdown.style.paddingTop = "";
      dropdown.style.paddingBottom = "";
      dropdown.innerHTML = "";
      selector.className = op.underlined ? "opcodeInline" : "opcodeOOL";
      selector.style.backgroundColor = op.color;

      // remove this opcode from the selected list.
      var selected = script.selectedOpcodes;
      for (var i = 0; i < selected.length; i++) {
        if (selected[i] == op.id) {
          selected[i] = selected[selected.length - 1];
          selected.pop();
          break;
        }
      }

      return;
    }

    // add this opcode to the selected list.
    if (!script.selectedOpcodes)
      script.selectedOpcodes = [];
    var found = false;
    var selected = script.selectedOpcodes;
    for (var i = 0; i < selected.length; i++)
      found |= selected[i] == op.id;
    if (!found)
      selected.push(op.id);

    selector.className = op.underlined ? "opcodeInlineSelected" : "opcodeOOLSelected";
    selector.style.backgroundColor = '#1E90FF';

    var text;

    if (this.measureIon) {
      text = "Block " + op.text;
      if (op.successors) {
        for (var i = 0; i < op.successors.length; i++)
          text += " -> #" + op.successors[i];
      }
      text += " :: " + op.hits + " hits<br></br>";

      text += "<span class='code'>";
      var codeLines = op.code.split('\n');
      for (var i = 0; i < codeLines.length; i++) {
        if (/#label/.test(codeLines[i]))
          continue;
        var className = (codeLines[i][0] == '[') ? 'masmHeader' : 'masm';
        text += "<span class='" + className + "'>" + htmlEscape(codeLines[i]) + "</span><br></br>";
      }
      text += "</span>";
    } else {
      text = "<a href='#' onclick='toggleOpcode(" + scriptIndex + "," + id + ")' class='opcodeDropdown'>";
      text += htmlEscape(op.text);
      text += "</a>";

      text += "<span class='metrics'> :: " + op.name + " ::";

      var counts = op.counts;
      for (var i = 0; i < metricNames.length; i++) {
        var name = metricNames[i];
        if (counts[name])
          text += " " + name + ": " + counts[name];
      }

      text += "</span>";
    }

    dropdown.style.paddingTop = "4px";
    dropdown.style.paddingBottom = "4px";
    dropdown.innerHTML = text;
  }
};

function opcodesOverlap(a, b)
{
  var astart = a.lineOffset;
  var aend = a.lineOffset + a.text.length;
  var bstart = b.lineOffset;
  var bend = b.lineOffset + b.text.length;

  if (astart < bstart)
    return bstart < aend;
  return astart < bend;
}

function WalkScriptText(scriptIndex, contents)
{
  // split the script text into separate lines, annotating each line with
  // expression information in that line.

  var linesArray = contents.text.split('\n').map(
    function(v) {
      return {text:v, ops:[]};
    });

  var line = linesArray[0];
  var lineIndex = 0;
  var lineOffset = 0;  // starting offset of the current line

  var opcodes = {};

  // store opcodes on the JITInspectorChrome for later use.
  this.scripts[scriptIndex].opcodes = opcodes;

  var opcodeArray = contents.opcodes || [];

  var maxActivity = 1;
  for (var i = 0; i < opcodeArray.length; i++) {
    var op = opcodeArray[i];
    opcodes[op.id] = op;
    var activity = this.measureActivity(op.counts);
    if (activity > maxActivity)
      maxActivity = activity;
  }

  var hasTextOffset = false;

  for (var i = 0; i < opcodeArray.length; i++) {
    var op = opcodeArray[i];

    // FIXME
    if (!op.text)
      continue;

    if (op.name == "pop" || op.name == "goto")
      continue;

    if (op.text == "(intermediate value)")
      op.text = op.name;

    // ignore opcodes which are not sufficiently active.
    var fraction = this.measureActivity(op.counts) / maxActivity;
    if (fraction < ACTIVITY_THRESHOLD)
      continue;
    op.color = activityColor(fraction);

    // for ops spanning multiple lines, strip out text past the newline.
    var newline = op.text.indexOf('\n');
    if (newline >= 0)
      op.text = op.text.substring(0, newline);

    // for opcodes with offsets into the script text, update the current line.
    if (op.textOffset) {
      hasTextOffset = true;

      while (op.textOffset < lineOffset) {
        line = linesArray[--lineIndex];
        lineOffset -= line.text.length + 1;
      }
      while (lineOffset + line.text.length < op.textOffset &&
             lineIndex != linesArray.length - 1) {
        lineOffset += line.text.length + 1;
        line = linesArray[++lineIndex];
      }

      var startOffset = op.textOffset - lineOffset;
      if (line.text.indexOf(op.text, startOffset) == startOffset)
        op.lineOffset = startOffset;
    } else if (!hasTextOffset) {
      if (op.line && Math.abs(op.line - contents.line) < linesArray.length)
        line = linesArray[op.line - contents.line];
    }

    line.ops.push(op);
  }

  var text = "<table class='codeDisplay' cellspacing='0' cellpadding='0'>";

  for (var lineIndex = 0; lineIndex < linesArray.length; lineIndex++) {
    var line = linesArray[lineIndex];

    text += "<tr><td class='code'>";
    text += htmlEscape(line.text);

    var underlinedArray = [];

    // assign a depth to each underlined opcode on the line. sort by text
    // length, placing longer opcodes above shorter ones.
    var sortedLines = line.ops.sort(function(a,b) { return a.text.length < b.text.length; });
    for (var opIndex = 0; opIndex < sortedLines.length; opIndex++) {
      var op = sortedLines[opIndex];
      if (!op.lineOffset)
        continue;
      var placedDepth = -1;
      for (var depth = 0; depth < underlinedArray.length; depth++) {
        var canPlace = true;
        for (var depthIndex = 0; depthIndex < underlinedArray[depth].length; depthIndex++) {
          if (opcodesOverlap(op, underlinedArray[depth][depthIndex])) {
            canPlace = false;
            break;
          }
        }
        if (canPlace) {
          placedDepth = depth;
          break;
        }
      }
      if (placedDepth == -1) {
        placedDepth = underlinedArray.length;
        underlinedArray.push([]);
      }
      underlinedArray[placedDepth].push(op);
      op.underlined = true;
    }

    var hasPrefix = false;
    for (var opIndex = 0; opIndex < line.ops.length; opIndex++) {
      var op = line.ops[opIndex];
      if (op.lineOffset)
        continue;
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

function WalkScriptIon(scriptIndex, contents)
{
  if (!contents.ion)
    return;

  // for now, only examine the most recent Ion compilation of the script.
  var ion = contents.ion[0];

  // split the script text into separate lines, annotating each line with
  // basic blocks starting roughly around that line.

  var linesArray = contents.text.split('\n').map(
    function(v) {
      return {text:v, blocks:[]};
    });

  var line = linesArray[0];
  var lineIndex = 0;
  var lineOffset = 0;  // starting offset of the current line

  var opcodes = {};

  // store opcodes on the JITInspectorChrome for later use.
  this.scripts[scriptIndex].opcodes = opcodes;

  // build a map from pc offsets to basic blocks at that pc.
  var opcodeMap = {};

  var maxActivity = 1;
  for (var i = 0; i < ion.length; i++) {
    var block = ion[i];
    opcodes[block.id] = block;
    if (this.measureIonBlockActivity(block) > maxActivity)
      maxActivity = this.measureIonBlockActivity(block);
    if (opcodeMap[block.offset])
      opcodeMap[block.offset].push(block);
    else
      opcodeMap[block.offset] = [block];
  }

  var hasTextOffset = false;

  var opcodeArray = contents.opcodes || [];
  for (var i = 0; i < opcodeArray.length; i++) {
    var op = opcodeArray[i];

    // for opcodes with offsets into the script text, update the current line.
    if (op.textOffset) {
      hasTextOffset = true;
      while (op.textOffset < lineOffset) {
        line = linesArray[--lineIndex];
        lineOffset -= line.text.length + 1;
      }
      while (lineOffset + line.text.length < op.textOffset &&
             lineIndex != linesArray.length - 1) {
        lineOffset += line.text.length + 1;
        line = linesArray[++lineIndex];
      }
    } else if (!hasTextOffset) {
      if (op.line && Math.abs(op.line - contents.line) < linesArray.length)
        line = linesArray[op.line - contents.line];
    }

    // Handle any basic blocks at this op.
    var blocks = opcodeMap[op.id];
    if (!blocks)
      continue;
    for (var j = 0; j < blocks.length; j++) {
      var block = blocks[j];
      block.text = "#" + block.id;

      // Ignore blocks which are not sufficiently active.
      var fraction = this.measureIonBlockActivity(block) / maxActivity;
      if (fraction < ACTIVITY_THRESHOLD)
        continue;
      block.color = activityColor(fraction);

      line.blocks.push(block);
    }
  }

  var text = "<table class='codeDisplay' cellspacing='0' cellpadding='0'>";

  for (var lineIndex = 0; lineIndex < linesArray.length; lineIndex++) {
    var line = linesArray[lineIndex];

    text += "<tr><td class='code'>";
    text += htmlEscape(line.text);

    var hasPrefix = false;
    for (var blockIndex = 0; blockIndex < line.blocks.length; blockIndex++) {
      var block = line.blocks[blockIndex];
      if (!hasPrefix)
        text += "   ";
      hasPrefix = true;
      text += " <a href='#' onclick='toggleOpcode(" + scriptIndex + "," + block.id + ")' class='opcodeOOL'"
            + " style = 'background-color:" + block.color + "' id='selector_" + scriptIndex + "_" + block.id + "'>";
      text += htmlEscape(block.text);
      text += "</a>";
    }

    text += "</td></tr>\n";

    // add empty <div> tags to hold dropdown information for each block.
    text += "<tr><td class='dropdown'>";
    for (var j = 0; j < line.blocks.length; j++) {
      var block = line.blocks[j];
      if (block.color)
        text += "<div id='dropdown_" + scriptIndex + "_" + block.id + "' class='dropdown'></div>";
    }
    text += "</td></tr>";
  }

  text += "</table>";
  return text;
}
