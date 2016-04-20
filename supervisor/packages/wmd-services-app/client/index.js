import ee, { ext } from '../lib/index.js';
import { _ } from 'meteor/underscore';

import AddServiceForm from './components/addServiceForm';

const services = [];

const baseService = {
  type: 'app'
};

const registerService = (service) => {
  if (!service.id)
    throw new Error('registerService called without id prop');
  if (!service.name)
    throw new Error('registerService called without name prop');

  services.push( _.extend({}, baseService, service) );
};

ext.registerServiceType({
  id: 'app',
  name: "Apps",
  services,
  AddServiceForm
});

ee.prototype.registerService = registerService;

export { ext };
export default ee;