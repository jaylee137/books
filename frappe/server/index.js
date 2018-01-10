const backends = {};
backends.sqllite = require('frappe-core/frappe/backends/sqlite');

const express = require('express');
const app = express();
const frappe = require('frappe-core');
const rest_api = require('./rest_api')
const models = require('frappe-core/frappe/server/models');
const common = require('frappe-core/frappe/common');
const bodyParser = require('body-parser');

module.exports = {
	async init() {
		await frappe.init();
		common.init_libs(frappe);
		await frappe.login();

		// walk and find models
		models.init();

	},

	async start({backend, connection_params, static}) {
		await this.init();

		// database
		frappe.db = await new backends[backend].Database(connection_params);
		await frappe.db.connect();
		await frappe.db.migrate();

		// app
		app.use(bodyParser.json());
		app.use(bodyParser.urlencoded({ extended: true }));
		app.use(express.static('./'));

		app.use(function (err, req, res, next) {
			console.error(err.stack);
			res.status(500).send('Something broke!');
		})
		// routes
		rest_api.setup(app);

		// listen
		frappe.app = app;
		frappe.server = app.listen(frappe.config.port);

	}
}

