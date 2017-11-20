var { CustomersModel } = require('./customers.model');

exports.CustomersController = new class CustomersController {
  constructor() { }

  /**
   * 
   * @returns {Promise} <ParseObject<Customer>>
   * @param {Number} customerId
   * @param {Boolean} json
   */
  getCustomerById(customerId, json = false) {
    console.log('CustomersModel::getCustomerById');
    return CustomersModel.getCustomersByFilters({
      equal: [{ key: 'customerId', value: customerId }]
    }).first().then(object => json ? object.toJSON() : object);
  } // END fixClearedVendorOrdersResults

}