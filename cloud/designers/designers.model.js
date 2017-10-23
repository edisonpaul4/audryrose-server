var { BaseModel } = require('../database/base.model');

exports.DesignersModel = new class DesignersModel extends BaseModel {
  constructor(){
    super();
    this.Designer = new Parse.Object.extend('Designer');
    this.Vendor = new Parse.Object.extend('Vendor');
    this.VendorOrder = new Parse.Object.extend('VendorOrder');
  }
  
  finishVendorOrder(vendorOrderNumber){
    console.log('DesignersModel::finishVendorOrder => searching order with vendorOrderNumber:', vendorOrderNumber);
    var query = new Parse.Query(this.VendorOrder);

    var setVendorOrderAsCompleted = vendorOrder => {
      console.log('DesignersModel::finishVendorOrder::setVendorOrderAsCompleted');
      return new Promise((resolve, reject) => {
        switch (true) {
          case typeof vendorOrder === 'undefined':
            reject({ 
              message: `Vendor order ${vendorOrderNumber} doesn't exist.` 
            });
          break;

          case vendorOrder.get('receivedAll') === true:
            reject({ 
              message: `Vendor order ${vendorOrderNumber} is already completed.` 
            });
          break;

          default:
            vendorOrder.set('receivedAll', true)
              .save()
              .then(vendorOrder => resolve(vendorOrder));
          break;
        }
      })
    }

    var updateVendor = vendorOrder => {
      console.log('DesignersModel::finishVendorOrder::updateVendor');
      return vendorOrder.get('vendor').save()
        .then(vendor => vendorOrder);
    }

    var filter = {
      includes: ['vendor'],
      equal: [
        { key: 'vendorOrderNumber', value: vendorOrderNumber }
      ]
    };
    return this.searchDatabase(filter, query)
      .first()
      .then(setVendorOrderAsCompleted)
      .then(updateVendor);
  }

  getDesignerByObjectId(objectId, includes = []){
    console.log(objectId)
    var query = new Parse.Query(this.Designer);
    var filters = {
      includes: includes,
      equal: [
        { key: 'objectId', value: objectId }
      ]
    };
    return this.searchDatabase(filters, query)
      .first();
  }

}