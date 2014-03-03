if (Meteor.isClient) {
	Router.map(function() {
		this.route('apps', {
			layoutTemplate: 'sidebar-layout',
			before: function() {
				this.subscribe('wmdRepos');
			},
			action: function() {
				this.render();
				this.render('appSidebar', { to: 'sidebar' });
			}
		});
	});

	Template.apps.apps = function() {
		_.defer(updateName);
		return Apps.find();
	}
	Template.appSidebar.apps = Template.apps.apps;

	Template.apps.repos = function() {
		var user = Meteor.user();
		if (!user) return;
		_.defer(updateName);
		return wmdRepos.find({
			userId: user._id,
			// should excluse if all branches are deployed
			//appId: { $exists: false }
		}, {
			sort: { name: 1 }
		});
	}

	Template.apps.servers = function() {
		return Servers.find({ $and: [
			{ destroyedAt: {$exists: false} },
			{ $or: [ { type: 'meteor' }, { type: 'combo'} ] }
		]});
	}

	var updateName = function() {
		var repoName = $('#appAdd_repoId option:selected').text();
		var branch = $('#appAdd_branch').val() || 'master';
		$('#appAdd_name').attr('placeholder',
			repoName.replace(/^[Mm]eteor-?/, '')
			+ (branch == 'master' ? '' : '-' + branch));

		var repo = wmdRepos.findOne($('#appAdd_repoId option:selected').val());
		if (!repo) return;
		$('#appAdd_meteorDir').attr('placeholder',
			repo.meteorDir == '.' ? '(project root)' : repo.meteorDir);
	}

	Template.appAdd.rendered = function() {
		Session.set('selectedRepoId', $('#appAdd_repoId').val());
	}

	/*
	Template.addApp.showRepos = function() {
		return Extensions.runFirstTrueHook('provides.repo').ranSomething;
	}
	*/

	Template.appAdd.helpers({
		'branches': function() {
			var repoId = Session.get('selectedRepoId');
			repo = wmdRepos.findOne(repoId);
			return repo ? repo.branches : null;
		}
	});

	Template.appAdd.events({
		'change #appAdd_repoId': function(event, tpl) {
			Session.set('selectedRepoId', $('#appAdd_repoId').val());
			updateName();
		},
		'change #appAdd_branch': function(event, tpl) {
			updateName();
		},
		'submit': function(event, tpl) {
			event.preventDefault();
			var name = $(tpl.find('#appAdd_name')).val();
			var repoId = $(tpl.find('#appAdd_repoId')).val();
			var branch = $(tpl.find('#appAdd_branch')).val();
			var deployOptions = {
				servers: {
					forcedOn: [ $(tpl.find('#appAdd_server')).val() ]
				}
			}
			var meteorDir = $(tpl.find('#appAdd_meteorDir')).val();
			if (meteorDir) deployOptions.meteorDir = meteorDir;
			Meteor.call('appAdd', name, repoId, branch, deployOptions,
				function(error) { alert(error); });
		}
	});
}

if (Meteor.isServer) {

	Meteor.methods({
		'appAdd': function(name, repoId, branch, deployOptions) {
			var repo = wmdRepos.findOne(repoId);
			if (!repo)
				throw new Meteor.Error(404, 'Not such repo');
			if (name && !name.match(/^[a-z][a-z0-9-_]{0,30}[a-z0-9]$/))
				throw new Meteor.Error(403, 'Invalid username (see rules)');
			if (Apps.findOne({name:name}))
				throw new Meteor.Error(403, 'There is already an app called "' + name + '"');

			var appData = {
				name: name || 
					(repo.name.replace(/^[Mm]eteor-?/, '')
					+ (branch == 'master' ? '' : '-' + branch)).substr(0,32),
				branch: branch,
				source: 'repo',
				repoId: repoId,
				repo: repo.name,
				meteorDir: deployOptions.meteorDir || repo.meteorDir,
				appId: 1000 + incrementCounter('apps'),
				instances: {
					min: 1,
					max: 1,
					target: 1,
					deployed: 0,
					running: 0,
					data: []
				}
			}

			// ext.registerPlugin('addApp', 'github', '0.1.0', callback)
			// Can modify appData if desired before db insert
			Extensions.runPlugin('addApp', repo.service,
					{ repo: repo, branch: branch, appData: appData });

			Apps.insert(appData);
		},

		'appAction': function(appId, action, instanceId) {
			var app = Apps.findOne(appId);
			if (!app)
				throw new Meteor.Error(404, 'No such app');
			if (appMethods[action]) {
				this.unblock();
				appMethods[action](app, app.instances.data[instanceId]);
			}
		},

		'foreverExit': function(slug) {
			slug = slug.split(':');
			console.log(slug);
			var app = Apps.findOne({name:slug[0]});
			var instanceId = slug[1];
			Apps.update({ _id: app._id, 'instances.data._id': instanceId }, {
				$set: { 'instances.data.$.state': 'crashed' },
				$inc: { 'instances.failing': 1 }
			});
		},
	});

	// global.  might be called from packages
	appMethods = {
		setup: function(app) {
			// actually "re" setup
			appInstall(app, freeServer('meteor'));
		},

		start: function(app, instance) {
			var instances = instance ? [instance] : app.instances.data;
			_.each(instances, function(instance) {
				if (instance.state == 'deployed' || instance.state == 'stopped' || instance.state == 'crashed')
					App.start(app, instance);
			});
		},

		stop: function(app, instance) {
			var instances = instance ? [instance] : app.instances.data;
			_.each(instances, function(instance) {
				if (instance.state == 'started' || instance.state == 'running')
					App.stop(app, instance);
			});
		},

		delete: function(app) {
			// TODO, safely stop all instances, delete from server
			Apps.remove(app._id);
		},

		update: function(app) {
			console.log('update');
			var data = {
				env: {
					USER: 'app' + app.appId,
					HOME: '/home/app' + app.appId,
					PATH: '/bin:/usr/bin:/usr/local/bin'
				}
			};

			var source = app.source;

			// move to seperate repo package (dupe from manage.js)
			if (source == 'repo') {
				data.repo = wmdRepos.findOne(app.repoId);
				data.env.BRANCH = app.branch;
				console.log(data.repo);
				Extensions.runPlugin('appInstall',
					data.repo.service, data, true);
			}

			var spawnData = {
				cmd: './appUpdate.sh',
				options: {
					cwd: '/home/app' + app.appId,
					env: data.env
				}
			};

			_.each(app.instances.data, function(ai) {
				console.log(ai.serverId);
				sendCommand(ai.serverId, 'spawnAndLog', spawnData, function(err, data) {
					console.log(data);
				});
			});		

		}
	};
}