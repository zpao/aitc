/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");
Cu.import("resource://services-common/utils.js");

function AitcService() {
  this.wrappedJSObject = this;
}
AitcService.prototype = {
  classID: Components.ID("{a3d387ca-fd26-44ca-93be-adb5fda5a78d}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                         Ci.nsISupportsWeakReference]),

  observe: function observe(subject, topic, data) {
    switch (topic) {
      case "app-startup":
        let os = Cc["@mozilla.org/observer-service;1"].
                 getService(Ci.nsIObserverService);
        os.addObserver(this, "final-ui-startup", true);
        break;
      case "final-ui-startup":
        // Start AITC service after 2000ms, only if classic sync is off.
        if (Preferences.get("services.sync.engine.apps", false)) {
          return;
        }

        CommonUtils.namedTimer(function() {
          // Kick-off!
          Cu.import("resource://services-aitc/main.js");
          new Aitc();
        }, 2000, this, "timer");
        break;
    }
  }
};

const components = [AitcService];
const NSGetFactory = XPCOMUtils.generateNSGetFactory(components);